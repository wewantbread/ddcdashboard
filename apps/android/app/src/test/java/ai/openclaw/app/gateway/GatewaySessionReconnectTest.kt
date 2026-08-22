package ai.openclaw.app.gateway

import ai.openclaw.app.NotificationNodeEventOutbox
import ai.openclaw.app.PendingNotificationNodeEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

private const val LIFECYCLE_TEST_TIMEOUT_MS = 8_000L
private const val LIFECYCLE_CONNECT_CHALLENGE_FRAME =
  """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce","ts":1700000000123}}"""

// After this many retry starts the pending wait is ~5s, so an un-interrupted wait is unmistakable,
// and a ladder that failed to reset would wait ~8s next instead of ~1s.
private const val BACKOFF_PROBE_RETRIES = 4
private const val SETTLE_INTO_BACKOFF_MS = 250L
private const val BACKOFF_TEST_TIMEOUT_MS = 30_000L
private const val WAKE_LATENCY_BUDGET_MS = 1_500L
private const val FAST_BAND_BUDGET_MS = 3_000L

private class ReconnectDeviceAuthStore : DeviceAuthTokenStore {
  override fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = null

  override fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) = Unit

  override fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
  ) = Unit
}

private class BlockingSaveDeviceAuthStore : DeviceAuthTokenStore {
  val saveStarted = CountDownLatch(1)
  val allowSave = CountDownLatch(1)

  override fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = null

  override fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) {
    saveStarted.countDown()
    allowSave.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
  }

  override fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
  ) = Unit
}

private class RecordingDeviceAuthStore : DeviceAuthTokenStore {
  val savedToken = CompletableDeferred<String>()

  override fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = null

  override fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) {
    savedToken.complete(token)
  }

  override fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
  ) = Unit
}

private data class ReconnectHarness(
  val session: GatewaySession,
  val sessionJob: Job,
)

private data class TerminalCallbackObservation(
  val inFlightHandlerCompleted: Boolean,
  val issuedTokenPersisted: Boolean,
)

private data class ReconnectServer(
  val server: MockWebServer,
  val sockets: ConcurrentLinkedQueue<WebSocket>,
) {
  val port: Int
    get() = server.port

  val requestCount: Int
    get() = server.requestCount

  fun shutdown() {
    sockets.forEach { runCatching { it.cancel() } }
    runCatching { server.shutdown() }
      .onFailure { err ->
        if (err.message != "Gave up waiting for queue to shut down") throw err
      }
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySessionReconnectTest {
  @Test
  fun capturedRequestLeaseRejectsReplacementSocketBeforeEnqueue() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val reconnected = CompletableDeferred<Unit>()
      val connectionCount = AtomicInteger()
      val unexpectedRequest = CompletableDeferred<Unit>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(connectResponseFrame(id))
          } else {
            unexpectedRequest.complete(Unit)
          }
        }
      val harness =
        createReconnectHarness(
          onConnected = {
            if (connectionCount.incrementAndGet() == 1) {
              connected.complete(Unit)
            } else {
              reconnected.complete(Unit)
            }
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val lease =
          requireNotNull(
            harness.session.captureRequestLease("manual|127.0.0.1|${server.port}"),
          )
        assertTrue(lease.isCurrent())
        harness.session.reconnect()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { reconnected.await() }
        assertFalse(lease.isCurrent())
        var committed = false
        assertFalse(lease.commitIfCurrent { committed = true })
        assertFalse(committed)
        val result =
          runCatching {
            lease.request(
              method = "sessions.patch",
              paramsJson = "{}",
            )
          }

        assertTrue(result.exceptionOrNull() is GatewayRequestNotEnqueued)
        assertNull(withTimeoutOrNull(200) { unexpectedRequest.await() })
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun connectedHelloPublishesCanonicalAndLegacyApprovalMethods() =
    runBlocking {
      val catalogs =
        listOf(
          setOf("approval.get", "approval.resolve"),
          setOf("exec.approval.get", "exec.approval.resolve"),
        )

      for (methods in catalogs) {
        val json = Json { ignoreUnknownKeys = true }
        val hello = CompletableDeferred<GatewayHelloSummary>()
        val server =
          startGatewayServer(json = json) { webSocket, id, method ->
            if (method == "connect") webSocket.send(connectResponseFrame(id, methods))
          }
        val harness = createReconnectHarness(onHello = hello::complete)

        try {
          connectNodeSession(harness.session, server.port)
          assertEquals(methods, withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { hello.await() }.methods)
        } finally {
          shutdownReconnectHarness(harness, server)
        }
      }
    }

  @Test
  fun connectedHelloKeepsMethodCatalogUnknownWhenHelloOmitsFeatures() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val hello = CompletableDeferred<GatewayHelloSummary>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id, methods = null))
        }
      val harness = createReconnectHarness(onHello = hello::complete)

      try {
        connectNodeSession(harness.session, server.port)
        assertNull(withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { hello.await() }.methods)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun disconnectAndJoinWaitsForNaturalFailureCallback() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val terminalCallbackStarted = CountDownLatch(1)
      val allowTerminalCallback = CountDownLatch(1)
      val blockNextTerminalCallback = AtomicBoolean(true)
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onConnected = { connected.complete(Unit) },
          onDisconnected = { message ->
            val shouldBlock =
              message.startsWith("Gateway ") &&
                blockNextTerminalCallback.compareAndSet(true, false)
            if (shouldBlock) {
              terminalCallbackStarted.countDown()
              allowTerminalCallback.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            }
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val connection = readField<Any>(harness.session, "currentConnection")
        val listener = readField<WebSocketListener>(connection, "listener")
        val socket = readField<WebSocket>(connection, "socket")
        val failure =
          launch(Dispatchers.IO) {
            listener.onFailure(socket, IOException("test failure"), null)
          }
        assertTrue(
          terminalCallbackStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS),
        )

        val disconnect = async { harness.session.disconnectAndJoin() }
        delay(100)
        assertFalse(disconnect.isCompleted)

        allowTerminalCallback.countDown()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { disconnect.await() }
        failure.join()
      } finally {
        allowTerminalCallback.countDown()
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun disconnectAndJoinWaitsForTerminalCallback() =
    runBlocking {
      val disconnected = CompletableDeferred<String>()
      val harness = createReconnectHarness(onDisconnected = { disconnected.complete(it) })

      try {
        harness.session.disconnectAndJoin()

        assertEquals("Offline", disconnected.await())
      } finally {
        harness.sessionJob.cancelAndJoin()
      }
    }

  @Test
  fun disconnectAndJoinWaitsForInFlightIssuedTokenPersistence() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val authStore = BlockingSaveDeviceAuthStore()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """{"type":"res","id":"$id","ok":true,"payload":{"auth":{"deviceToken":"issued-token","role":"node","scopes":[]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
            )
          }
        }
      val harness = createReconnectHarness(deviceAuthStore = authStore)

      try {
        connectNodeSession(harness.session, server.port)
        assertTrue(authStore.saveStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))

        val disconnect = async { harness.session.disconnectAndJoin() }
        delay(100)
        assertFalse(disconnect.isCompleted)

        authStore.allowSave.countDown()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { disconnect.await() }
      } finally {
        authStore.allowSave.countDown()
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun reconnectDoesNotRetireConnectionBeforeIssuedTokenPersistenceFinishes() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val authStore = BlockingSaveDeviceAuthStore()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """{"type":"res","id":"$id","ok":true,"payload":{"auth":{"deviceToken":"issued-token","role":"node","scopes":[]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
            )
          }
        }
      val harness = createReconnectHarness(deviceAuthStore = authStore)

      try {
        connectNodeSession(harness.session, server.port)
        assertTrue(authStore.saveStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
        val connection = readField<Any>(harness.session, "currentConnection")

        harness.session.reconnect()
        delay(200)

        assertTrue(readField<Any?>(harness.session, "currentConnection") === connection)
        authStore.allowSave.countDown()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { harness.session.disconnectAndJoin() }
      } finally {
        authStore.allowSave.countDown()
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun failureOrdersDisconnectAfterInFlightHandlerAndAcceptedConnectResponse() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val authStore = RecordingDeviceAuthStore()
      val connectRequestId = CompletableDeferred<String>()
      val blockEventStarted = CountDownLatch(1)
      val allowBlockEvent = CountDownLatch(1)
      val blockEventCompleted = AtomicBoolean()
      val terminalCallback = CompletableDeferred<TerminalCallbackObservation>()
      val allowTerminalCallback = CountDownLatch(1)
      val retiredInvokeCount = AtomicInteger()
      val server =
        startGatewayServer(json = json) { _, id, method ->
          if (method == "connect") connectRequestId.complete(id)
        }
      val harness =
        createReconnectHarness(
          onDisconnected = { message ->
            if (message.startsWith("Gateway error:")) {
              terminalCallback.complete(
                TerminalCallbackObservation(
                  inFlightHandlerCompleted = blockEventCompleted.get(),
                  issuedTokenPersisted = authStore.savedToken.isCompleted,
                ),
              )
              allowTerminalCallback.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            }
          },
          deviceAuthStore = authStore,
          onEvent = { event, _ ->
            if (event == "block") {
              blockEventStarted.countDown()
              try {
                allowBlockEvent.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
              } finally {
                blockEventCompleted.set(true)
              }
            }
          },
          onInvoke = {
            retiredInvokeCount.incrementAndGet()
            GatewaySession.InvokeResult.ok("{}")
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        val requestId = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connectRequestId.await() }
        val connection = readField<Any>(harness.session, "currentConnection")
        val listener = readField<WebSocketListener>(connection, "listener")
        val socket = readField<WebSocket>(connection, "socket")
        listener.onMessage(socket, """{"type":"event","event":"block","payload":{}}""")
        assertTrue(blockEventStarted.await(LIFECYCLE_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
        listener.onMessage(
          socket,
          """{"type":"event","event":"node.invoke.request","payload":{"id":"retired-invoke","nodeId":"node-1","command":"notification.action"}}""",
        )
        listener.onMessage(
          socket,
          """{"type":"res","id":"$requestId","ok":true,"payload":{"auth":{"deviceToken":"issued-token","role":"node","scopes":[]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
        )
        listener.onFailure(socket, IOException("test failure"), null)
        assertNull(withTimeoutOrNull(100) { terminalCallback.await() })

        allowBlockEvent.countDown()

        val observation = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { terminalCallback.await() }
        assertTrue(observation.inFlightHandlerCompleted)
        assertTrue(observation.issuedTokenPersisted)
        assertEquals("issued-token", withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { authStore.savedToken.await() })
        assertEquals(0, retiredInvokeCount.get())
        val messagePumpJob = readField<Job>(connection, "messagePumpJob")
        assertTrue(withTimeoutOrNull(1_000) { messagePumpJob.join() } != null)

        allowTerminalCallback.countDown()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { harness.session.disconnectAndJoin() }
      } finally {
        allowBlockEvent.countDown()
        allowTerminalCallback.countDown()
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun definitelyUnsentNodeEventRemainsQueued() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val rejectedNodeEvent = CompletableDeferred<Unit>()
      val receivedNodeEvent = CompletableDeferred<Unit>()
      val receivedNodeEventCount = AtomicInteger()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          when (method) {
            "connect" -> webSocket.send(connectResponseFrame(id))
            "node.event" -> {
              receivedNodeEventCount.incrementAndGet()
              receivedNodeEvent.complete(Unit)
              webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{}}""")
            }
          }
        }
      val harness = createReconnectHarness(onConnected = { connected.complete(Unit) })

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }
        val connection = readField<Any>(harness.session, "currentConnection")
        val socketField = connection.javaClass.getDeclaredField("socket").apply { isAccessible = true }
        val socket = socketField.get(connection) as WebSocket
        socketField.set(connection, RejectFirstSendWebSocket(socket) { rejectedNodeEvent.complete(Unit) })
        val outbox =
          NotificationNodeEventOutbox {
            harness.session.sendNodeEventWithOutcome(it.event, it.payloadJson)
          }
        val deliveryJob = launch { outbox.deliver() }

        try {
          outbox.enqueue(PendingNotificationNodeEvent("notifications.changed", "{}"))
          withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { rejectedNodeEvent.await() }
          outbox.onConnected()
          withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { receivedNodeEvent.await() }
          delay(100)
          assertEquals(1, receivedNodeEventCount.get())
        } finally {
          deliveryJob.cancelAndJoin()
        }
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun connectedCallbackFailureClosesSocketBeforeRetry() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val firstClosed = CompletableDeferred<Unit>()
      val secondConnected = CompletableDeferred<Unit>()
      val callbackCount = AtomicInteger()
      val server =
        startGatewayServer(
          json = json,
          onClosed = { firstClosed.complete(Unit) },
        ) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val harness =
        createReconnectHarness(
          onConnected = {
            if (callbackCount.incrementAndGet() == 1) {
              throw IllegalStateException("callback failed")
            }
            secondConnected.complete(Unit)
          },
        )

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstClosed.await() }
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondConnected.await() }
        assertEquals(2, callbackCount.get())
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun staleConnectionDrainCannotCancelReplacementRpc() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val firstConnected = CompletableDeferred<Unit>()
      val secondConnected = CompletableDeferred<Unit>()
      val replacementRequest = CompletableDeferred<Pair<WebSocket, String>>()
      val connectionCount = AtomicInteger(0)
      val firstServer =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") webSocket.send(connectResponseFrame(id))
        }
      val secondServer =
        startGatewayServer(json = json) { webSocket, id, method ->
          when (method) {
            "connect" -> webSocket.send(connectResponseFrame(id))
            "slow.method" -> replacementRequest.complete(webSocket to id)
          }
        }
      val harness =
        createReconnectHarness(
          onConnected = {
            when (connectionCount.incrementAndGet()) {
              1 -> firstConnected.complete(Unit)
              2 -> secondConnected.complete(Unit)
            }
          },
        )

      try {
        connectNodeSession(harness.session, firstServer.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstConnected.await() }
        val oldConnection = readField<Any>(harness.session, "currentConnection")

        connectNodeSession(harness.session, secondServer.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondConnected.await() }
        val newRequest =
          async {
            harness.session.requestDetailed("slow.method", null, timeoutMs = 30_000)
          }
        val (replacementSocket, requestId) =
          withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { replacementRequest.await() }

        val failPending = oldConnection.javaClass.getDeclaredMethod("failPending")
        failPending.isAccessible = true
        failPending.invoke(oldConnection)

        assertNull(withTimeoutOrNull(200) { newRequest.await() })
        replacementSocket.send(
          """{"type":"res","id":"$requestId","ok":true,"payload":{"connection":2}}""",
        )
        val newResult = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { newRequest.await() }
        assertTrue(newResult.ok)
        assertEquals("""{"connection":2}""", newResult.payloadJson)
      } finally {
        shutdownReconnectHarness(harness, firstServer, secondServer)
      }
    }

  @Suppress("UNCHECKED_CAST")
  private fun <T> readField(
    target: Any,
    name: String,
  ): T {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    return field.get(target) as T
  }

  @Test
  fun connectToNewGatewayClosesActiveConnectionAndStartsReplacement() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val firstConnect = CompletableDeferred<Unit>()
      val firstClosed = CompletableDeferred<Unit>()
      val secondConnect = CompletableDeferred<Unit>()
      val secondClosed = CompletableDeferred<Unit>()
      val firstServer =
        startGatewayServer(
          json = json,
          onClosed = { firstClosed.complete(Unit) },
        ) { webSocket, id, method ->
          if (method == "connect") {
            firstConnect.complete(Unit)
            webSocket.send(connectResponseFrame(id))
          }
        }
      val secondServer =
        startGatewayServer(
          json = json,
          onClosed = { secondClosed.complete(Unit) },
        ) { webSocket, id, method ->
          if (method == "connect") {
            secondConnect.complete(Unit)
            webSocket.send(connectResponseFrame(id))
          }
        }
      val harness = createReconnectHarness()

      try {
        connectNodeSession(harness.session, firstServer.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstConnect.await() }

        connectNodeSession(harness.session, secondServer.port)

        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { firstClosed.await() }
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondConnect.await() }
        assertEquals(1, secondServer.requestCount)
        harness.session.disconnect()
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { secondClosed.await() }
      } finally {
        shutdownReconnectHarness(harness, firstServer, secondServer)
      }
    }

  @Test
  fun bootstrapNodePairingRequiredKeepsReconnectActive() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
            pauseReconnect = false,
            reason = "not-paired",
          ),
      )

    assertFalse(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = true,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun bootstrapNodePairingRequiredWithoutRetryHintPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
            reason = "not-paired",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = true,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun nonBootstrapPairingRequiredStillPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
            reason = "not-paired",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = false,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun tokenFailuresPauseUnlessOneDeviceTokenRetryIsPending() {
    val cases =
      listOf(
        Triple("AUTH_TOKEN_MISMATCH", false, true),
        Triple("AUTH_TOKEN_MISMATCH", true, false),
        Triple("AUTH_DEVICE_TOKEN_MISMATCH", false, true),
        Triple("AUTH_TOKEN_NOT_CONFIGURED", false, true),
        Triple("AUTH_PASSWORD_NOT_CONFIGURED", false, true),
        Triple("AUTH_SCOPE_MISMATCH", false, true),
      )

    for ((code, pendingDeviceTokenRetry, expected) in cases) {
      val error =
        GatewaySession.ErrorShape(
          code = "INVALID_REQUEST",
          message = "authentication failed",
          details =
            GatewayErrorDetails(
              code = code,
              canRetryWithDeviceToken = false,
              recommendedNextStep = null,
            ),
        )
      val actual =
        shouldPauseGatewayReconnectAfterAuthFailure(
          error = error,
          hasBootstrapToken = false,
          role = "operator",
          scopes = listOf("operator.read"),
          pendingDeviceTokenRetry = pendingDeviceTokenRetry,
        )

      assertEquals("$code pending=$pendingDeviceTokenRetry", expected, actual)
    }
  }

  @Test
  fun structuredRecoveryAdviceControlsReconnectPause() {
    val cases =
      listOf(
        Triple("wait_then_retry", false, false),
        Triple("retry_with_device_token", true, false),
        Triple("retry_with_device_token", false, true),
        Triple("update_auth_configuration", false, true),
        Triple("update_auth_credentials", false, true),
        Triple("review_auth_configuration", false, true),
      )

    for ((nextStep, pendingDeviceTokenRetry, expected) in cases) {
      val error =
        GatewaySession.ErrorShape(
          code = "INVALID_REQUEST",
          message = "authentication failed",
          details =
            GatewayErrorDetails(
              code = "AUTH_UNAUTHORIZED",
              canRetryWithDeviceToken = nextStep == "retry_with_device_token",
              recommendedNextStep = nextStep,
            ),
        )
      val actual =
        shouldPauseGatewayReconnectAfterAuthFailure(
          error = error,
          hasBootstrapToken = false,
          role = "operator",
          scopes = listOf("operator.read"),
          pendingDeviceTokenRetry = pendingDeviceTokenRetry,
        )

      assertEquals("$nextStep pending=$pendingDeviceTokenRetry", expected, actual)
    }
  }

  @Test
  fun authRateLimitPausesDespiteRetryAdvice() {
    val error =
      GatewaySession.ErrorShape(
        code = "INVALID_REQUEST",
        message = "authentication rate limited",
        details =
          GatewayErrorDetails(
            code = "AUTH_RATE_LIMITED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = false,
        role = "operator",
        scopes = listOf("operator.read"),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun protocolMismatchPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "INVALID_REQUEST",
        message = "protocol mismatch",
        details =
          GatewayErrorDetails(
            code = "PROTOCOL_MISMATCH",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
            clientMinProtocol = 4,
            clientMaxProtocol = 4,
            expectedProtocol = 5,
            minimumProbeProtocol = 4,
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = false,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun bootstrapRoleUpgradeStillPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
            reason = "role-upgrade",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = true,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun pairingRequiredFailureNotifiesPauseReconnectProblem() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connectFailure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """
              {"type":"res","id":"$id","ok":false,"error":{"code":"NOT_PAIRED","message":"pairing required: device approval is required","details":{"code":"PAIRING_REQUIRED","reason":"not-paired","requestId":"request-1"}}}
              """.trimIndent(),
            )
          }
        }
      val harness =
        createReconnectHarness { error, pauseReconnect ->
          connectFailure.complete(error to pauseReconnect)
        }

      try {
        connectNodeSession(harness.session, server.port)
        val (error, pauseReconnect) = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connectFailure.await() }

        assertEquals("PAIRING_REQUIRED", error.details?.code)
        assertEquals("not-paired", error.details?.reason)
        assertEquals("request-1", error.details?.requestId)
        assertTrue(pauseReconnect)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun pairingRequiredFailureDropsUnsafeRequestId() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connectFailure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """
              {"type":"res","id":"$id","ok":false,"error":{"code":"NOT_PAIRED","message":"pairing required: device approval is required","details":{"code":"PAIRING_REQUIRED","reason":"not-paired","requestId":"request-1;echo unsafe"}}}
              """.trimIndent(),
            )
          }
        }
      val harness =
        createReconnectHarness { error, pauseReconnect ->
          connectFailure.complete(error to pauseReconnect)
        }

      try {
        connectNodeSession(harness.session, server.port)
        val (error, pauseReconnect) = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connectFailure.await() }

        assertEquals("PAIRING_REQUIRED", error.details?.code)
        assertEquals("not-paired", error.details?.reason)
        assertNull(error.details?.requestId)
        assertTrue(pauseReconnect)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun protocolMismatchFailurePreservesProtocolDetailsAndPausesReconnect() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connectFailure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            webSocket.send(
              """
              {"type":"res","id":"$id","ok":false,"error":{"code":"INVALID_REQUEST","message":"protocol mismatch","details":{"code":"PROTOCOL_MISMATCH","clientMinProtocol":4,"clientMaxProtocol":4,"expectedProtocol":5,"minimumProbeProtocol":4}}}
              """.trimIndent(),
            )
          }
        }
      val harness =
        createReconnectHarness { error, pauseReconnect ->
          connectFailure.complete(error to pauseReconnect)
        }

      try {
        connectNodeSession(harness.session, server.port)
        val (error, pauseReconnect) = withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connectFailure.await() }

        assertEquals("PROTOCOL_MISMATCH", error.details?.code)
        assertEquals(4, error.details?.clientMinProtocol)
        assertEquals(4, error.details?.clientMaxProtocol)
        assertEquals(5, error.details?.expectedProtocol)
        assertEquals(4, error.details?.minimumProbeProtocol)
        assertTrue(pauseReconnect)
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  @Test
  fun methodFailurePreservesMissingScopeDetails() =
    runBlocking {
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          when (method) {
            "connect" -> webSocket.send(connectResponseFrame(id))
            "question.list" ->
              webSocket.send(
                """
                {"type":"res","id":"$id","ok":false,"error":{"code":"FORBIDDEN","message":"permission denied","details":{"code":"MISSING_SCOPE","missingScope":"operator.questions","requiredScopes":["operator.questions"]}}}
                """.trimIndent(),
              )
          }
        }
      val harness = createReconnectHarness(onConnected = { connected.complete(Unit) })

      try {
        connectNodeSession(harness.session, server.port)
        withTimeout(LIFECYCLE_TEST_TIMEOUT_MS) { connected.await() }

        val result = harness.session.requestDetailed("question.list", "{}")

        assertFalse(result.ok)
        assertEquals("MISSING_SCOPE", result.error?.details?.code)
        assertEquals("operator.questions", result.error?.details?.missingScope)
        assertEquals(listOf("operator.questions"), result.error?.details?.requiredScopes)
        assertEquals("operator.questions", result.error?.missingScope())
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  private fun createReconnectHarness(
    onConnected: () -> Unit = {},
    onHello: (GatewayHelloSummary) -> Unit = {},
    onDisconnected: (String) -> Unit = {},
    deviceAuthStore: DeviceAuthTokenStore = ReconnectDeviceAuthStore(),
    onEvent: (String, String?) -> Unit = { _, _ -> },
    onInvoke: suspend (GatewaySession.InvokeRequest) -> GatewaySession.InvokeResult = {
      GatewaySession.InvokeResult.ok("""{"handled":true}""")
    },
    onConnectFailure: (GatewaySession.ErrorShape, Boolean) -> Unit = { _, _ -> },
  ): ReconnectHarness {
    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = testDeviceIdentityStore(app),
        deviceAuthStore = deviceAuthStore,
        onConnected = { summary ->
          onConnected()
          onHello(summary)
        },
        onDisconnected = onDisconnected,
        onConnectFailure = onConnectFailure,
        onEvent = onEvent,
        onInvoke = onInvoke,
      )
    return ReconnectHarness(session = session, sessionJob = sessionJob)
  }

  private suspend fun connectNodeSession(
    session: GatewaySession,
    port: Int,
  ) {
    session.connect(
      endpoint =
        GatewayEndpoint(
          stableId = "manual|127.0.0.1|$port",
          name = "test",
          host = "127.0.0.1",
          port = port,
          tlsEnabled = false,
        ),
      token = "test-token",
      bootstrapToken = null,
      password = null,
      options =
        GatewayConnectOptions(
          role = "node",
          scopes = listOf("node:invoke"),
          caps = emptyList(),
          commands = emptyList(),
          permissions = emptyMap(),
          client =
            GatewayClientInfo(
              id = "openclaw-android-test",
              displayName = "Android Test",
              version = "1.0.0-test",
              platform = "android",
              mode = "node",
              instanceId = "android-test-instance",
              deviceFamily = "android",
              modelIdentifier = "test",
            ),
        ),
      tls = null,
    )
  }

  private suspend fun shutdownReconnectHarness(
    harness: ReconnectHarness,
    vararg servers: ReconnectServer,
  ) {
    harness.session.disconnect()
    harness.sessionJob.cancelAndJoin()
    servers.forEach { it.shutdown() }
  }

  private fun connectResponseFrame(
    id: String,
    methods: Set<String>? = emptySet(),
  ): String {
    if (methods == null) {
      return """{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}"""
    }
    val encodedMethods = methods.joinToString(",") { JsonPrimitive(it).toString() }
    return """{"type":"res","id":"$id","ok":true,"payload":{"features":{"methods":[$encodedMethods]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}"""
  }

  private fun startGatewayServer(
    json: Json,
    onClosed: () -> Unit = {},
    onRequestFrame: (webSocket: WebSocket, id: String, method: String) -> Unit,
  ): ReconnectServer {
    val sockets = ConcurrentLinkedQueue<WebSocket>()
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
              MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    sockets += webSocket
                    webSocket.send(LIFECYCLE_CONNECT_CHALLENGE_FRAME)
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val frame = json.parseToJsonElement(text).jsonObject
                    if (frame["type"]?.jsonPrimitive?.content != "req") return
                    val id = frame["id"]?.jsonPrimitive?.content ?: return
                    val method = frame["method"]?.jsonPrimitive?.content ?: return
                    onRequestFrame(webSocket, id, method)
                  }

                  override fun onClosing(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    onClosed()
                  }

                  override fun onClosed(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    onClosed()
                  }

                  override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: Response?,
                  ) {
                    onClosed()
                  }
                },
              )
          }
        start()
      }
    return ReconnectServer(server = server, sockets = sockets)
  }

  // --- reconnect backoff policy -------------------------------------------------------------
  //
  // The delay policy is a pure function so these can pin every band without waiting minutes of
  // wall clock. `legacyReconnectDelayMs` reproduces the delay this loop shipped before the
  // battery fix and is used as a control: the new policy must never retry sooner than it did.

  @Test
  fun transientReconnectDelaysAreUnchanged() {
    // A brief blip must still recover as fast as it always did, whatever jitter is drawn.
    for (attempt in 1..5) {
      for (jitter in listOf(0.0, 0.25, 0.5, 0.75, 1.0)) {
        assertEquals(
          "attempt $attempt jitter $jitter",
          legacyReconnectDelayMs(attempt),
          gatewayReconnectDelayMs(attempt, jitter),
        )
      }
    }
  }

  @Test
  fun reconnectDelayKeepsGrowingPastTheOldSteadyCadence() {
    // The defect was that growth stopped here and the loop probed at this cadence forever.
    for (jitter in listOf(0.0, 0.5, 1.0)) {
      var previous = 0L
      for (attempt in 1..24) {
        val delay = gatewayReconnectDelayMs(attempt, jitter)
        assertTrue("attempt $attempt jitter $jitter went backwards", delay >= previous)
        previous = delay
      }
      assertTrue(
        "jitter $jitter never left the old cadence",
        gatewayReconnectDelayMs(12, jitter) > GATEWAY_RECONNECT_MIN_STEADY_DELAY_MS,
      )
    }
  }

  @Test
  fun sustainedFailureLeavesSecondsScaleCadence() {
    // The user-visible defect: an unreachable gateway kept being probed every few seconds all day.
    for (attempt in 13..64) {
      for (jitter in listOf(0.0, 0.5, 1.0)) {
        assertTrue(
          "attempt $attempt jitter $jitter still probes every ${gatewayReconnectDelayMs(attempt, jitter)}ms",
          gatewayReconnectDelayMs(attempt, jitter) >= GATEWAY_RECONNECT_MAX_DELAY_MS / 2,
        )
      }
    }
  }

  @Test
  fun steadyReconnectDelayStaysInsideItsJitterBand() {
    assertEquals(GATEWAY_RECONNECT_MAX_DELAY_MS / 2, gatewayReconnectDelayMs(20, jitter = 0.0))
    assertEquals(GATEWAY_RECONNECT_MAX_DELAY_MS, gatewayReconnectDelayMs(20, jitter = 1.0))
    assertEquals(225_000L, gatewayReconnectDelayMs(20, jitter = 0.5))
  }

  @Test
  fun reconnectDelayIsNeverShorterThanBeforeThisChange() {
    // The whole point is less radio work, so no attempt number may retry sooner than it used to.
    for (attempt in 1..256) {
      for (jitter in listOf(0.0, 0.33, 1.0)) {
        assertTrue(
          "attempt $attempt jitter $jitter retries sooner than the old policy",
          gatewayReconnectDelayMs(attempt, jitter) >= legacyReconnectDelayMs(attempt),
        )
      }
    }
  }

  @Test
  fun reconnectDelayStaysBoundedSoAnEndpointOnlyRestartIsStillFound() {
    // Android never reports a network change when only the gateway process restarts, so probing
    // must never stop or drift unbounded; it just has to get cheap.
    for (attempt in 1..1024) {
      val delay = gatewayReconnectDelayMs(attempt, jitter = 1.0)
      assertTrue("attempt $attempt stopped probing", delay > 0)
      assertTrue("attempt $attempt exceeded the ceiling", delay <= GATEWAY_RECONNECT_MAX_DELAY_MS)
    }
  }

  @Test
  fun reconnectDelayClampsOutOfRangeInputs() {
    val first = gatewayReconnectDelayMs(1, jitter = 0.0)
    assertEquals(first, gatewayReconnectDelayMs(0, jitter = 0.0))
    assertEquals(first, gatewayReconnectDelayMs(-7, jitter = 0.0))
    assertEquals(
      gatewayReconnectDelayMs(20, jitter = 0.0),
      gatewayReconnectDelayMs(20, jitter = -1.0),
    )
    assertEquals(
      gatewayReconnectDelayMs(20, jitter = 1.0),
      gatewayReconnectDelayMs(20, jitter = 4.0),
    )
  }

  private fun legacyReconnectDelayMs(attempt: Int): Long = minOf(8_000L, (350.0 * Math.pow(1.7, attempt.toDouble())).toLong())

  // --- reconnect wake semantics -------------------------------------------------------------

  @Test
  fun networkRestoreDuringBackoffRetriesNowAndResumesTheFastBand() = runBlocking { assertWakeInterruptsBackoff { it.retryAfterNetworkRestore() } }

  @Test
  fun manualReconnectDuringBackoffRetriesNowAndResumesTheFastBand() = runBlocking { assertWakeInterruptsBackoff { it.reconnect() } }

  @Test
  fun clearingAnAuthPauseAfterALongOutageResumesTheFastBand() =
    runBlocking {
      // An auth pause can be entered after the ladder has already climbed. Clearing the pause is a
      // deliberate user action, so the retry that follows must not inherit the long steady wait.
      val json = Json { ignoreUnknownKeys = true }
      val pauseNext = AtomicBoolean(false)
      val retryStarts = Channel<Long>(Channel.UNLIMITED)
      val paused = CompletableDeferred<Unit>()
      val server =
        startGatewayServer(json = json) { webSocket, id, method ->
          if (method == "connect") {
            val details =
              if (pauseNext.get()) {
                """{"code":"AUTH_TOKEN_MISSING"}"""
              } else {
                """{"code":"AUTH_TOKEN_INVALID","recommendedNextStep":"wait_then_retry"}"""
              }
            webSocket.send("""{"type":"res","id":"$id","ok":false,"error":{"code":"UNAUTHORIZED","message":"denied","details":$details}}""")
          }
        }
      val harness =
        createReconnectHarness(
          onDisconnected = { status -> if (status == "Reconnecting…") retryStarts.trySend(System.nanoTime()) },
          onConnectFailure = { _, pauseReconnect -> if (pauseReconnect) paused.complete(Unit) },
        )

      try {
        connectNodeSession(harness.session, server.port)
        // Climb the ladder on failures that explicitly do not pause reconnect.
        withTimeout(BACKOFF_TEST_TIMEOUT_MS) { repeat(BACKOFF_PROBE_RETRIES) { retryStarts.receive() } }
        pauseNext.set(true)
        withTimeout(BACKOFF_TEST_TIMEOUT_MS) { paused.await() }

        // Clear the pause the way the user would, and let the next attempt fail normally again.
        pauseNext.set(false)
        harness.session.reconnect()
        val resumedAt = withTimeout(BACKOFF_TEST_TIMEOUT_MS) { retryStarts.receive() }
        val nextAt = withTimeout(BACKOFF_TEST_TIMEOUT_MS) { retryStarts.receive() }
        val gapMs = (nextAt - resumedAt) / 1_000_000
        assertTrue(
          "next retry waited ${gapMs}ms; clearing the auth pause did not reset the ladder",
          gapMs < FAST_BAND_BUDGET_MS,
        )
      } finally {
        shutdownReconnectHarness(harness, server)
      }
    }

  /**
   * Drives real connect failures until the loop is deep enough in backoff for the wait to be
   * unmistakable, then wakes it and checks both halves of the contract: the wait ends immediately,
   * and the attempt that follows a failed wake is back in the fast band instead of the steady one.
   *
   * Retry starts are counted through the status callback, which reports "Reconnecting…" exactly
   * once per retry iteration; the gap between two of them is the reconnect cadence itself.
   */
  private suspend fun assertWakeInterruptsBackoff(wake: (GatewaySession) -> Unit) {
    val retryStarts = Channel<Long>(Channel.UNLIMITED)
    val harness =
      createReconnectHarness(
        onDisconnected = { status -> if (status == "Reconnecting…") retryStarts.trySend(System.nanoTime()) },
      )
    // A port with nothing listening: every connect fails immediately, so backoff sets the pace.
    val deadPort =
      MockWebServer().run {
        start()
        val assigned = port
        shutdown()
        assigned
      }

    try {
      connectNodeSession(harness.session, deadPort)
      withTimeout(BACKOFF_TEST_TIMEOUT_MS) { repeat(BACKOFF_PROBE_RETRIES) { retryStarts.receive() } }

      // That retry fails too, so the loop is now waiting out a multi-second backoff.
      delay(SETTLE_INTO_BACKOFF_MS)
      val wokeAt = System.nanoTime()
      wake(harness.session)
      val retriedAt = withTimeout(BACKOFF_TEST_TIMEOUT_MS) { retryStarts.receive() }
      val wakeLatencyMs = (retriedAt - wokeAt) / 1_000_000
      assertTrue(
        "wake took ${wakeLatencyMs}ms; the pending backoff was not interrupted",
        wakeLatencyMs < WAKE_LATENCY_BUDGET_MS,
      )

      // The woken attempt fails as well. The ladder must have restarted, so the next retry comes
      // back in the fast band instead of at the steady cadence the loop had already climbed to.
      val followUpAt = withTimeout(BACKOFF_TEST_TIMEOUT_MS) { retryStarts.receive() }
      val followUpMs = (followUpAt - retriedAt) / 1_000_000
      assertTrue(
        "next retry waited ${followUpMs}ms; the ladder did not reset after the wake",
        followUpMs < FAST_BAND_BUDGET_MS,
      )
    } finally {
      harness.session.disconnect()
      harness.sessionJob.cancelAndJoin()
    }
  }
}

private class RejectFirstSendWebSocket(
  private val delegate: WebSocket,
  private val onReject: () -> Unit,
) : WebSocket by delegate {
  private var rejectNext = true

  override fun send(text: String): Boolean {
    if (rejectNext) {
      rejectNext = false
      onReject()
      return false
    }
    return delegate.send(text)
  }

  override fun send(bytes: ByteString): Boolean = delegate.send(bytes)

  override fun request(): Request = delegate.request()
}

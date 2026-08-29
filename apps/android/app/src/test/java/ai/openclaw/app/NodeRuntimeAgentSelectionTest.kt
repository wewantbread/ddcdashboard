package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeRuntimeAgentSelectionTest {
  @Test
  fun selectingAgentRebindsCanonicalMainSession() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val runtime = NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))

    runtime.selectChatAgent(" scout ")

    assertEquals("scout", resolveAgentIdFromMainSessionKey(runtime.mainSessionKey.value))
    assertEquals(runtime.mainSessionKey.value, runtime.chatSessionKey.value)
  }

  @Test
  fun manualSessionSelectionWinsOverLateCatalogContinuation() =
    runBlocking {
      val runtime = createConnectedRuntime()
      try {
        val requestStarted = CompletableDeferred<Unit>()
        val releaseResponse = CompletableDeferred<Unit>()
        runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
          check(method == "sessions.catalog.continue")
          requestStarted.complete(Unit)
          releaseResponse.await()
          """{"sessionKey":"agent:main:catalog"}"""
        }
        val entry =
          SessionCatalogEntry(
            catalogId = "codex",
            hostId = "desktop",
            threadId = "thread-1",
            agentId = "main",
            status = "idle",
            archived = false,
            canContinue = true,
          )

        val continuation = async { runtime.continueSessionCatalogEntry(entry) }
        withTimeout(2_000) { requestStarted.await() }
        runtime.switchChatSession("agent:main:user")
        assertEquals(null, runtime.sessionCatalogState.value.continuingEntryId)
        releaseResponse.complete(Unit)

        assertFalse(withTimeout(2_000) { continuation.await() })
        assertEquals("agent:main:user", runtime.chatSessionKey.value)
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }

  private fun createConnectedRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.session.selection.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs)).also { runtime ->
      ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
      ReflectionHelpers.setField(runtime, "operatorConnected", true)
    }
  }
}

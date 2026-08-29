package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerPermissionSelectionTest {
  private val json = chatControllerTestJson

  @Test
  fun selectionUsesSessionPatchAndTracksExplicitDefaultEvents() =
    runTest {
      val patches = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          respond(
            "sessions.list",
            """{"sessions":[{"key":"main","permissionMode":"guarded"}]}""",
          )
          respond("sessions.patch") { paramsJson ->
            patches += paramsJson.orEmpty()
            "{}"
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()
      assertEquals(
        ChatPermissionMode.Guarded,
        controller.sessions.value
          .single()
          .permissionMode,
      )

      assertTrue(controller.setSessionPermissionModeAwait("main", ChatPermissionMode.Full))
      val params = json.parseToJsonElement(patches.single()) as JsonObject
      assertEquals("full", (params["permissionMode"] as JsonPrimitive).content)
      assertEquals(
        ChatPermissionMode.Full,
        controller.sessions.value
          .single()
          .permissionMode,
      )

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","session":{"key":"main","agentId":"main","permissionMode":null}}""",
      )
      advanceUntilIdle()
      assertNull(
        controller.sessions.value
          .single()
          .permissionMode,
      )
      assertTrue(
        controller.sessions.value
          .single()
          .hasPermissionModeMetadata,
      )
    }

  @Test
  fun fastModeSelectionParsesBooleanSessionAndResolvedState() =
    runTest {
      val patches = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          respond(
            "sessions.list",
            """{"sessions":[{"key":"main","fastMode":false,"effectiveFastMode":false}]}""",
          )
          respond("sessions.patch") { paramsJson ->
            patches += paramsJson.orEmpty()
            """{"resolved":{"fastMode":true,"effectiveFastMode":true}}"""
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()
      assertEquals(
        ChatFastMode.Off,
        controller.sessions.value
          .single()
          .fastMode,
      )
      assertEquals(
        ChatFastMode.Off,
        controller.sessions.value
          .single()
          .effectiveFastMode,
      )

      controller.setSessionFastMode("main", enabled = true)
      advanceUntilIdle()

      val params = json.parseToJsonElement(patches.single()) as JsonObject
      assertEquals("true", (params["fastMode"] as JsonPrimitive).content)
      val session = controller.sessions.value.single()
      assertEquals(ChatFastMode.On, session.fastMode)
      assertEquals(ChatFastMode.On, session.effectiveFastMode)
      assertTrue(session.hasFastModeMetadata)
      assertTrue(session.hasEffectiveFastModeMetadata)
    }

  @Test
  fun fastModeSelectionIsOptimisticAndRollsBackAfterRejection() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val controller =
        createScriptedChatController {
          respond(
            "sessions.list",
            """{"sessions":[{"key":"main","fastMode":"off","effectiveFastMode":"off"}]}""",
          )
          respond("sessions.patch") {
            patchStarted.complete(Unit)
            releasePatch.await()
            throw IllegalStateException("rejected")
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()

      controller.setSessionFastMode("main", enabled = true)

      val optimistic = controller.sessions.value.single()
      assertEquals(ChatFastMode.On, optimistic.fastMode)
      assertEquals(ChatFastMode.On, optimistic.effectiveFastMode)
      assertEquals(setOf("main"), controller.pendingSessionSettingsKeys.value)

      patchStarted.await()
      releasePatch.complete(Unit)
      advanceUntilIdle()

      val rolledBack = controller.sessions.value.single()
      assertEquals(ChatFastMode.Off, rolledBack.fastMode)
      assertEquals(ChatFastMode.Off, rolledBack.effectiveFastMode)
      assertFalse(controller.pendingSessionSettingsKeys.value.contains("main"))
    }

  @Test
  fun legacyFastModeOverrideCanBeClearedForAnUnsupportedProvider() =
    runTest {
      val patches = mutableListOf<String>()
      val controller =
        createScriptedChatController {
          respond(
            "sessions.list",
            """{"sessions":[{"key":"main","fastMode":"on","effectiveFastMode":"on"}]}""",
          )
          respond("sessions.patch") { paramsJson ->
            patches += paramsJson.orEmpty()
            """{"resolved":{"fastMode":null,"effectiveFastMode":null}}"""
          }
        }

      controller.refreshSessions()
      advanceUntilIdle()

      controller.setSessionFastMode(
        sessionKey = "main",
        enabled = false,
        clearOverride = true,
      )
      advanceUntilIdle()

      val params = json.parseToJsonElement(patches.single()) as JsonObject
      assertTrue(params["fastMode"] is JsonNull)
      val session = controller.sessions.value.single()
      assertEquals(null, session.fastMode)
      assertEquals(null, session.effectiveFastMode)
      assertFalse(controller.pendingSessionSettingsKeys.value.contains("main"))
    }

  @Test
  fun defaultSelectionSendsJsonNull() =
    runTest {
      val patches = mutableListOf<String>()
      val controller =
        createChatController { method, paramsJson ->
          if (method == "sessions.patch") patches += paramsJson.orEmpty()
          "{}"
        }

      assertTrue(controller.setSessionPermissionModeAwait("main", null))

      val params = json.parseToJsonElement(patches.single()) as JsonObject
      assertTrue(params["permissionMode"] is JsonNull)
      assertNull(
        controller.sessions.value
          .single()
          .permissionMode,
      )
    }

  @Test
  fun immediateSendWaitsForPendingPermissionSelection() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val requests = mutableListOf<String>()
      val controller =
        createChatController { method, _ ->
          requests += method
          when (method) {
            "sessions.patch" -> {
              patchStarted.complete(Unit)
              releasePatch.await()
              "{}"
            }
            "chat.send" -> """{"runId":"run-ok","status":"ok"}"""
            else -> "{}"
          }
        }
      controller.handleGatewayEvent("health", null)

      controller.setSessionPermissionMode("main", ChatPermissionMode.Workspace)
      patchStarted.await()
      val send =
        async {
          controller.sendMessageAwaitAcceptance(
            message = "hello",
            thinkingLevel = "off",
            attachments = emptyList(),
          )
        }
      yield()
      assertEquals(listOf("sessions.patch"), requests.filter { it == "sessions.patch" || it == "chat.send" })

      releasePatch.complete(Unit)
      assertTrue(send.await())
      assertEquals(
        listOf("sessions.patch", "chat.send"),
        requests.filter { it == "sessions.patch" || it == "chat.send" },
      )
    }
}

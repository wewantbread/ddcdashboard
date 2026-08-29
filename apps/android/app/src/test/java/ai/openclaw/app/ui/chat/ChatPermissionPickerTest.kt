package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatPermissionMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatPermissionPickerTest {
  @Test
  fun optionsMatchTheOfficialWebUiOrderAndCopy() {
    val options = chatPermissionOptions()

    assertEquals(
      listOf(null, ChatPermissionMode.ReadOnly, ChatPermissionMode.Guarded, ChatPermissionMode.Workspace, ChatPermissionMode.Full),
      options.map { it.mode },
    )
    assertEquals(
      listOf("Default", "Read only", "Guarded", "Workspace", "Full access"),
      options.map { it.label },
    )
    assertEquals("Follow the agent's configured policy.", options[0].description)
    assertEquals(
      "Read within the session root; writes and commands are blocked.",
      options[1].description,
    )
    assertEquals(
      "No reviewer; files and commands are unrestricted.",
      options[4].description,
    )
  }

  @Test
  fun fullAccessRequiresAdminWhileOtherModesRemainSelectable() {
    assertFalse(canSelectChatPermissionMode(ChatPermissionMode.Full, canSelectFull = false))
    assertTrue(canSelectChatPermissionMode(ChatPermissionMode.Full, canSelectFull = true))
    assertTrue(canSelectChatPermissionMode(ChatPermissionMode.Workspace, canSelectFull = false))
    assertTrue(canSelectChatPermissionMode(null, canSelectFull = false))
  }

  @Test
  fun modeLabelsIncludeDefault() {
    assertEquals("Default", chatPermissionModeLabel(null))
    assertEquals("Full access", chatPermissionModeLabel(ChatPermissionMode.Full))
  }
}

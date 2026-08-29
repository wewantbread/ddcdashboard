package ai.openclaw.app.ui.chat

import ai.openclaw.app.PendingAssistantAutoSend
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatPlanStep
import ai.openclaw.app.chat.ChatPlanStepStatus
import ai.openclaw.app.chat.ChatProgressCard
import ai.openclaw.app.chat.ChatThinkingLevelOption
import ai.openclaw.app.chat.SessionBranch
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatScreenTest {
  @Test
  fun thinkingGaugeFollowsTheSelectedSliderStep() {
    val options =
      listOf("off", "low", "medium", "high", "max").map {
        ChatThinkingLevelOption(id = it, label = it)
      }

    assertEquals(0f, chatThinkingGaugeFraction("off", options), 0.0001f)
    assertEquals(0.25f, chatThinkingGaugeFraction("low", options), 0.0001f)
    assertEquals(0.5f, chatThinkingGaugeFraction("medium", options), 0.0001f)
    assertEquals(0.75f, chatThinkingGaugeFraction("high", options), 0.0001f)
    assertEquals(1f, chatThinkingGaugeFraction("max", options), 0.0001f)
  }

  @Test
  fun thinkingGaugeKeepsKnownMaximumAliasesAtTheRightEdge() {
    assertEquals(1f, chatThinkingGaugeFraction("xhigh", emptyList()), 0.0001f)
    assertEquals(1f, chatThinkingGaugeFraction("ultimate", emptyList()), 0.0001f)
  }

  @Test
  fun assistantContentUsesTheFullRowWhileUserMessagesRemainBubbles() {
    assertEquals(1f, chatBubbleWidthFraction(isUser = false), 0.0001f)
    assertEquals(0.78f, chatBubbleWidthFraction(isUser = true), 0.0001f)
    assertEquals(24, CHAT_BUBBLE_CORNER_RADIUS_DP)
  }

  @Test
  fun progressCardCompletionControlsTheAttachedPanelState() {
    val note = ChatProgressCard(revision = 1, updatedAt = 1L, markdown = "note", steps = emptyList())
    val completed = note.copy(steps = listOf(ChatPlanStep("Done", ChatPlanStepStatus.Completed)))
    val paused = note.copy(steps = listOf(ChatPlanStep("Waiting", ChatPlanStepStatus.InProgress)))

    assertFalse(progressCardIsComplete(note, hasActiveRun = true))
    assertTrue(progressCardIsComplete(note, hasActiveRun = false))
    assertTrue(progressCardIsComplete(completed, hasActiveRun = true))
    assertFalse(progressCardIsComplete(paused, hasActiveRun = false))
  }

  @Test
  fun composerAuxiliaryControlsStayVisibleForActiveInteraction() {
    assertTrue(chatComposerAuxiliaryControlsPinned(true, false, false, false))
    assertTrue(chatComposerAuxiliaryControlsPinned(false, true, false, false))
    assertTrue(chatComposerAuxiliaryControlsPinned(false, false, true, false))
    assertTrue(chatComposerAuxiliaryControlsPinned(false, false, false, true))
    assertFalse(chatComposerAuxiliaryControlsPinned(false, false, false, false))
    assertEquals(3_000L, CHAT_COMPOSER_AUXILIARY_IDLE_MS)
  }

  @Test
  fun fastModeControlRequiresSupportAndAnIdleConnectedChat() {
    fun enabled(
      supported: Boolean = true,
      connected: Boolean = true,
      gatewayAvailable: Boolean = true,
      loading: Boolean = false,
      sending: Boolean = false,
      activeRun: Boolean = false,
      streaming: Boolean = false,
      settingsMutationPending: Boolean = false,
    ) = chatFastModeControlEnabled(supported, connected, gatewayAvailable, loading, sending, activeRun, streaming, settingsMutationPending)

    assertTrue(enabled())
    assertFalse(enabled(supported = false))
    assertFalse(enabled(connected = false))
    assertFalse(enabled(gatewayAvailable = false))
    assertFalse(enabled(loading = true))
    assertFalse(enabled(sending = true))
    assertFalse(enabled(activeRun = true))
    assertFalse(enabled(streaming = true))
    assertFalse(enabled(settingsMutationPending = true))
  }

  @Test
  fun jumpToLatestReservesItsTouchTargetBelowMessages() {
    assertEquals(0.dp, chatReaderListBottomInset(showJumpToLatest = false))
    assertEquals(56.dp, chatReaderListBottomInset(showJumpToLatest = true))
  }

  @Test
  fun branchMessageCountUsesCountNeutralCopy() {
    assertEquals("Messages: 1", branchMessageCountText(1))
    assertEquals("Messages: 2", branchMessageCountText(2))
    assertEquals(
      "Messages: 2",
      branchMetadataText(SessionBranch("leaf", "", 2, updatedAt = null, active = false)),
    )
  }

  @Test
  fun longUserMessagesProduceABoundedPlainTextPreview() {
    assertNull(ChatUserMessageDisclosurePolicy.collapsedPreview("Short prompt"))
    assertNull(ChatUserMessageDisclosurePolicy.collapsedPreview(List(12) { "line" }.joinToString("\n")))
    assertNull(ChatUserMessageDisclosurePolicy.collapsedPreview("a".repeat(700)))
    assertEquals(
      List(12) { "line" }.joinToString("\n") + "…",
      ChatUserMessageDisclosurePolicy.collapsedPreview(List(13) { "line" }.joinToString("\n")),
    )
    assertEquals(
      "a".repeat(700) + "…",
      ChatUserMessageDisclosurePolicy.collapsedPreview("a".repeat(701)),
    )
  }

  @Test
  fun disclosureDoesNotReorderMixedUserContent() {
    val mixedContent =
      listOf(
        ChatMessageContent(type = "text", text = "a".repeat(701)),
        ChatMessageContent(type = "image", fileName = "photo.png", base64 = "AAAA"),
        ChatMessageContent(type = "text", text = "caption"),
      )

    assertFalse(shouldUseUserMessageDisclosure(isUser = true, content = mixedContent))
  }

  @Test
  fun realtimeTalkLaunchRequestsPermissionBeforeSetupOrStart() {
    assertEquals(
      ChatRealtimeTalkLaunch.RequestPermission,
      resolveChatRealtimeTalkLaunch(hasMicPermission = false, requiresSetup = true),
    )
    assertEquals(
      ChatRealtimeTalkLaunch.ShowSetupMessage,
      resolveChatRealtimeTalkLaunch(hasMicPermission = true, requiresSetup = true),
    )
    assertEquals(
      ChatRealtimeTalkLaunch.StartTalk,
      resolveChatRealtimeTalkLaunch(hasMicPermission = true, requiresSetup = false),
    )
  }

  @Test
  fun composerTrailingActionPreservesTalkAndRunStopPrecedence() {
    assertEquals(
      ChatComposerTrailingAction.StopTalk,
      resolveChatComposerTrailingAction(talkActive = true, runActive = true, sendEnabled = true),
    )
    assertEquals(
      ChatComposerTrailingAction.Stop,
      resolveChatComposerTrailingAction(talkActive = false, runActive = true, sendEnabled = true),
    )
    assertEquals(
      ChatComposerTrailingAction.Send,
      resolveChatComposerTrailingAction(talkActive = false, runActive = false, sendEnabled = true),
    )
    assertEquals(
      ChatComposerTrailingAction.StartTalk,
      resolveChatComposerTrailingAction(talkActive = false, runActive = false, sendEnabled = false),
    )
  }

  @Test
  fun resolvesPendingAssistantAutoSendOnlyWhenChatIsReady() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway", agentId = "main", sessionKey = "agent:main:device")
    val pending = PendingAssistantAutoSend(prompt = "  summarize mail  ", owner = owner)
    assertNull(
      resolvePendingAssistantAutoSend(
        pending = pending,
        currentOwner = owner,
        healthOk = false,
        pendingRunCount = 0,
      ),
    )
    assertNull(
      resolvePendingAssistantAutoSend(
        pending = pending,
        currentOwner = owner,
        healthOk = true,
        pendingRunCount = 1,
      ),
    )
    assertNull(
      resolvePendingAssistantAutoSend(
        pending = pending,
        currentOwner = owner.copy(sessionKey = "agent:main:other"),
        healthOk = true,
        pendingRunCount = 0,
      ),
    )
    assertEquals(
      pending,
      resolvePendingAssistantAutoSend(
        pending = pending,
        currentOwner = owner,
        healthOk = true,
        pendingRunCount = 0,
      ),
    )
  }

  @Test
  fun initialChatLoadUsesMainWhenNoSessionIsSelected() {
    assertEquals(
      "agent:ops:device",
      resolveInitialChatLoadSessionKey(
        sessionKey = "main",
        mainSessionKey = "agent:ops:device",
      ),
    )
  }

  @Test
  fun initialChatLoadPreservesSelectedSession() {
    assertNull(
      resolveInitialChatLoadSessionKey(
        sessionKey = "session:history",
        mainSessionKey = "agent:ops:device",
      ),
    )
  }

  @Test
  fun healthyEmptyChatShowsStarterStateInsteadOfLoadingPlaceholder() {
    assertFalse(
      showChatLoadingPlaceholder(
        historyLoading = true,
        healthOk = true,
        gatewayOffline = false,
      ),
    )
    assertTrue(
      showChatLoadingPlaceholder(
        historyLoading = true,
        healthOk = false,
        gatewayOffline = false,
      ),
    )
  }
}

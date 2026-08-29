import type { CodexServerNotification } from "./protocol.js";

export function childStartedNotification(childThreadId: string): CodexServerNotification {
  return {
    method: "thread/started",
    params: {
      thread: {
        id: childThreadId,
        parentThreadId: "thread-1",
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: "thread-1", depth: 1 },
          },
        },
      },
    },
  } as CodexServerNotification;
}

export function childCompletedNotification(
  childThreadId: string,
  finalText?: string,
): CodexServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId: childThreadId,
      turn: {
        id: `${childThreadId}-turn`,
        status: "completed",
        items: finalText
          ? [
              {
                type: "agentMessage",
                id: `${childThreadId}-final`,
                phase: "final_answer",
                text: finalText,
              },
            ]
          : [],
        itemsView: "full",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  } as CodexServerNotification;
}

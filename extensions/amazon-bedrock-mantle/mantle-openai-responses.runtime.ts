import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createOpenAIResponsesContextManagementWrapper } from "openclaw/plugin-sdk/provider-stream-family";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { sanitizeTransportPayloadText } from "openclaw/plugin-sdk/provider-transport-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { supportsMantleExplicitPromptCaching } from "./model-capabilities.js";

const EXPLICIT_PROMPT_CACHE_MODE = { mode: "explicit" } as const;
const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

function splitSystemPromptCacheBoundary(
  text: string,
): { stablePrefix: string; dynamicSuffix: string } | undefined {
  const boundaryIndex = text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  return boundaryIndex < 0
    ? undefined
    : {
        stablePrefix: text.slice(0, boundaryIndex).trimEnd(),
        dynamicSuffix: text.slice(boundaryIndex + SYSTEM_PROMPT_CACHE_BOUNDARY.length).trimStart(),
      };
}

function hasPromptCacheBreakpoint(input: unknown): boolean {
  if (!Array.isArray(input)) {
    return false;
  }
  return input.some((item) => {
    const content = asOptionalObjectRecord(item)?.content;
    return (
      Array.isArray(content) &&
      content.some((block) => asOptionalObjectRecord(block)?.prompt_cache_breakpoint !== undefined)
    );
  });
}

function findSystemTextContent(input: unknown): {
  content: unknown[];
  index: number;
  block: Record<string, unknown>;
} | null {
  if (!Array.isArray(input)) {
    return null;
  }
  for (const item of input) {
    const message = asOptionalObjectRecord(item);
    if (message?.role !== "developer" && message?.role !== "system") {
      continue;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    const index = message.content.findIndex((block) => {
      const record = asOptionalObjectRecord(block);
      return record?.type === "input_text" && typeof record.text === "string";
    });
    if (index >= 0) {
      const block = asOptionalObjectRecord(message.content[index]);
      if (block) {
        return { content: message.content, index, block };
      }
    }
  }
  return null;
}

function applyMantleExplicitPromptCaching(params: {
  payload: Record<string, unknown>;
  context: Parameters<StreamFn>[1];
  options: Parameters<StreamFn>[2];
}): void {
  params.payload.prompt_cache_options ??= { ...EXPLICIT_PROMPT_CACHE_MODE };
  const cacheMode = asOptionalObjectRecord(params.payload.prompt_cache_options)?.mode;
  if (cacheMode !== "explicit" || params.options?.cacheRetention === "none") {
    return;
  }
  if (hasPromptCacheBreakpoint(params.payload.input)) {
    return;
  }

  const target = findSystemTextContent(params.payload.input);
  if (!target) {
    return;
  }
  const split = splitSystemPromptCacheBoundary(params.context.systemPrompt ?? "");
  if (!split) {
    target.block.prompt_cache_breakpoint = { ...EXPLICIT_PROMPT_CACHE_MODE };
    return;
  }

  const stablePrefix = sanitizeTransportPayloadText(split.stablePrefix);
  if (!stablePrefix) {
    return;
  }
  target.block.text = stablePrefix;
  target.block.prompt_cache_breakpoint = { ...EXPLICIT_PROMPT_CACHE_MODE };
  const dynamicSuffix = sanitizeTransportPayloadText(split.dynamicSuffix);
  if (dynamicSuffix) {
    target.content.splice(target.index + 1, 0, {
      type: "input_text",
      text: dynamicSuffix,
    });
  }
}

/** Decorate Mantle GPT-5.6 Responses requests with deterministic cache breakpoints. */
export function createMantleOpenAIResponsesStreamWrapper(
  wrapContext: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  const sourceApi = wrapContext.sourceApi ?? wrapContext.model?.api;
  if (
    !supportsMantleExplicitPromptCaching(wrapContext.modelId) ||
    sourceApi !== "openai-responses"
  ) {
    return undefined;
  }
  const policyStreamFn = createOpenAIResponsesContextManagementWrapper(
    wrapContext.streamFn,
    wrapContext.extraParams,
  );
  const policyAwareStreamFn: StreamFn = (model, context, options) =>
    policyStreamFn(
      sourceApi === model.api ? model : { ...model, api: sourceApi },
      context,
      options,
    );
  return createPayloadPatchStreamWrapper(
    policyAwareStreamFn,
    ({ payload, context: streamContext, options }) => {
      applyMantleExplicitPromptCaching({ payload, context: streamContext, options });
    },
  );
}

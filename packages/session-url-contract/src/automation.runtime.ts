import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { encodeControlUiPathSegment, normalizeControlUiBasePath } from "./grammar.js";

export type ControlUiAutomationTab = "settings" | "runs";

export type ControlUiAutomationRoute = {
  jobId: string;
  tab: ControlUiAutomationTab;
};

type BuildControlUiAutomationPathParams = {
  basePath?: string;
  tab?: ControlUiAutomationTab;
};

export const CONTROL_UI_AUTOMATIONS_PATH = "/automations";
export const CONTROL_UI_AUTOMATIONS_PATH_ALIAS = "/cron";

function decodePathSegment(segment: string): string | null {
  const escaped = segment === "~dot" ? "." : segment === "~dotdot" ? ".." : segment;
  const encoded = escaped.startsWith("~~") ? escaped.slice(1) : escaped;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function buildControlUiAutomationPath(
  jobId: string,
  params: BuildControlUiAutomationPathParams = {},
): string | null {
  const normalizedJobId = normalizeNullableString(jobId);
  if (!normalizedJobId) {
    return null;
  }
  const basePath = normalizeControlUiBasePath(params.basePath);
  const path = `${basePath}${CONTROL_UI_AUTOMATIONS_PATH}/${encodeControlUiPathSegment(normalizedJobId)}`;
  return params.tab === "runs" ? `${path}/runs` : path;
}

export function parseControlUiAutomationPath(
  pathname: string,
  basePath = "",
): ControlUiAutomationRoute | null {
  const normalizedBasePath = normalizeControlUiBasePath(basePath);
  const normalizedPath = pathname.trim().replace(/\/+$/u, "") || "/";
  const roots = [CONTROL_UI_AUTOMATIONS_PATH, CONTROL_UI_AUTOMATIONS_PATH_ALIAS].map(
    (path) => `${normalizedBasePath}${path}`,
  );
  const root = roots.find((candidate) =>
    normalizedPath.toLowerCase().startsWith(`${candidate.toLowerCase()}/`),
  );
  if (!root) {
    return null;
  }
  const segments = normalizedPath.slice(root.length + 1).split("/");
  if (segments.length > 2 || !segments[0] || (segments[1] && segments[1] !== "runs")) {
    return null;
  }
  const jobId = decodePathSegment(segments[0]);
  if (jobId === null || !jobId.trim()) {
    return null;
  }
  return { jobId, tab: segments[1] === "runs" ? "runs" : "settings" };
}

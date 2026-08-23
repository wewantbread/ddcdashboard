import {
  buildControlUiAutomationPath,
  parseControlUiAutomationPath,
  type ControlUiAutomationRoute,
  type ControlUiAutomationTab,
} from "@openclaw/session-url-contract/automation.runtime";
import { normalizeRouteBasePath, normalizeRoutePath } from "@openclaw/uirouter";

export function pathForAutomation(
  jobId: string,
  tab: ControlUiAutomationTab = "settings",
  basePath = "",
): string {
  const path = buildControlUiAutomationPath(jobId, { tab, basePath });
  if (!path) {
    throw new Error("Invalid automation job id for a route path.");
  }
  return path;
}

export function automationRouteFromPath(
  pathname: string,
  basePath = "",
): ControlUiAutomationRoute | null {
  return parseControlUiAutomationPath(
    normalizeRoutePath(pathname),
    normalizeRouteBasePath(basePath),
  );
}

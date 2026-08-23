import type { RouteLocation } from "@openclaw/uirouter";
import { automationRouteFromPath } from "../../app-automation-paths.runtime.ts";
import { INTERNAL_ROUTE_PATH_PARAM } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { CronDetailTab } from "./view.ts";

export type CronRouteData = {
  jobId: string | null;
  detailTab: CronDetailTab;
};

function cronRouteLocation(location: RouteLocation): RouteLocation {
  const params = new URLSearchParams(location.search);
  const pathname = params.get(INTERNAL_ROUTE_PATH_PARAM) ?? location.pathname;
  params.delete(INTERNAL_ROUTE_PATH_PARAM);
  const search = params.toString();
  return { pathname, search: search ? `?${search}` : "", hash: location.hash };
}

export function loadCronRouteData(
  context: ApplicationContext,
  { location }: { location: RouteLocation },
): CronRouteData {
  const route = automationRouteFromPath(cronRouteLocation(location).pathname, context.basePath);
  return {
    jobId: route?.jobId ?? null,
    detailTab: route?.tab === "runs" ? "history" : "settings",
  };
}

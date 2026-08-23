import { definePage } from "@openclaw/uirouter";
import { INTERNAL_ROUTE_PATH_PARAM, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export type { CronRouteData } from "./route-location.runtime.ts";

const loadCronPage = () => import("./cron-page.ts");

export const page = definePage({
  ...routePageSpec("cron"),
  loaderDeps: (_context: ApplicationContext, location) =>
    new URLSearchParams(location.search).get(INTERNAL_ROUTE_PATH_PARAM) ?? location.pathname,
  // The URL grammar is automation-only code; load it with the page data rather
  // than pulling the deep-link helper into every Control UI startup.
  loader: (context: ApplicationContext, options) =>
    loadCronPage().then(({ loadCronRouteData }) => loadCronRouteData(context, options)),
  component: loadCronPage,
});

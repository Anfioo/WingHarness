import { invokeCommand } from "../../base";
import type {
  ScoopInstallRequest,
  ScoopLocationRequest,
  ScoopPlan,
  ScoopRunRequest,
  ScoopSearchHit,
  ScoopStatus,
} from "./types";

/** Current install, paths, environment variables and local catalog. */
export function scoopStatus(): Promise<ScoopStatus> {
  return invokeCommand<Record<string, never>, ScoopStatus>("scoop_status", {});
}

/** Local bucket-manifest search. Empty queries return nothing. */
export function scoopSearch(query: string): Promise<ScoopSearchHit[]> {
  return invokeCommand<{ query: string }, ScoopSearchHit[]>("scoop_search", { query });
}

/**
 * Points the fixed Scoop path at the chosen folder and writes `SCOOP` /
 * `SCOOP_GLOBAL`. Used to adopt an existing install without reinstalling.
 */
export function scoopApplyLocation(request: ScoopLocationRequest): Promise<ScoopStatus> {
  return invokeCommand<{ request: ScoopLocationRequest }, ScoopStatus>("scoop_apply_location", {
    request,
  });
}

/** Creates the folders and the link, then prepares the installer run. */
export function scoopPrepareInstall(request: ScoopInstallRequest): Promise<ScoopPlan> {
  return invokeCommand<{ request: ScoopInstallRequest }, ScoopPlan>("scoop_prepare_install", {
    request,
  });
}

/** Prepares `scoop install …`, `scoop search …` or a proxy sync. */
export function scoopPlanRun(request: ScoopRunRequest): Promise<ScoopPlan> {
  return invokeCommand<{ request: ScoopRunRequest }, ScoopPlan>("scoop_plan_run", { request });
}

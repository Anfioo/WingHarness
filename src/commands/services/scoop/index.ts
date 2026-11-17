import { invokeCommand } from "../../base";
import type {
  ScoopApp,
  ScoopBucketInfo,
  ScoopBucketRequest,
  ScoopBucketResult,
  ScoopInstallRequest,
  ScoopLocationRequest,
  ScoopPackageInfo,
  ScoopPlan,
  ScoopRunRequest,
  ScoopSearchHit,
  ScoopStatus,
} from "./types";

/** Current install, paths, environment variables and local catalog. */
export function scoopStatus(): Promise<ScoopStatus> {
  return invokeCommand<Record<string, never>, ScoopStatus>("scoop_status", {});
}

/**
 * Whether a Scoop install is on disk, read from the fixed folder alone — the
 * answer `scoopStatus` spends its time on the catalog to reach.
 */
export function scoopInstalled(): Promise<boolean> {
  return invokeCommand<Record<string, never>, boolean>("scoop_installed", {});
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

/**
 * `scoop bucket add`, done by the app: a bucket is a git clone under
 * `<root>\buckets\<name>`, cloned through the bundled git with this proxy.
 */
export function scoopAddBucket(request: ScoopBucketRequest): Promise<ScoopBucketResult> {
  return invokeCommand<{ request: ScoopBucketRequest }, ScoopBucketResult>("scoop_add_bucket", {
    request,
  });
}

/** `scoop bucket rm`: deletes the clone; the apps installed from it stay. */
export function scoopRemoveBucket(spec: string): Promise<ScoopBucketResult> {
  return invokeCommand<{ spec: string }, ScoopBucketResult>("scoop_remove_bucket", { spec });
}

/**
 * What a package's manifest says: version, description, licence, dependencies,
 * notes and the manifest itself, plus what is installed on disk.
 */
export function scoopPackageInfo(
  name: string,
  bucket?: string | null,
  global = false
): Promise<ScoopPackageInfo> {
  return invokeCommand<{ name: string; bucket: string | null; global: boolean }, ScoopPackageInfo>(
    "scoop_package_info",
    { name, bucket: bucket ?? null, global }
  );
}

/** One bucket: its clone's git metadata and the manifests it holds. */
export function scoopBucketInfo(name: string): Promise<ScoopBucketInfo> {
  return invokeCommand<{ name: string }, ScoopBucketInfo>("scoop_bucket_info", { name });
}

/**
 * Pins an installed app at its version, or releases it. Scoop keeps the pin in
 * the app's own install record, so this is one file write and not a run;
 * the refreshed app list comes back with it.
 */
export function scoopSetHold(name: string, global: boolean, hold: boolean): Promise<ScoopApp[]> {
  return invokeCommand<{ name: string; global: boolean; hold: boolean }, ScoopApp[]>(
    "scoop_set_hold",
    { name, global, hold }
  );
}

import type { RuntimeKind } from "@/commands";

/**
 * The runtime archives this app publishes. The copy is shipped with the app on
 * purpose: "official" means one known build, not "whatever the upstream project
 * released today", so a rebuild cannot silently change what the feature runs.
 */
export const OFFICIAL_RUNTIME_URLS: Record<RuntimeKind, string> = {
  clash: "https://wingharness.dpdns.org/WingHarnessRuntime/Clash/ClashRuntime.7z",
  frp: "https://wingharness.dpdns.org/WingHarnessRuntime/Frp/FrpRuntime.7z",
};

/** The executable each feature looks for at the root of its directory. */
export function runtimeBinaryName(kind: RuntimeKind): string {
  return kind === "clash" ? "mihomo.exe" : "frpc.exe";
}

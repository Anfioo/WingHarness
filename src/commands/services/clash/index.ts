// Clash page commands: one thin wrapper per `prism-core` command.

import { invokeCommand } from "../../base";
import type {
  ApplyView,
  ClashConnectionsView,
  ClashCoreMetrics,
  ClashIpInfo,
  ClashLogsView,
  ClashProfile,
  ClashProxiesView,
  ClashRulesView,
  ClashRuntime,
  ClashSubscription,
  ClashSummary,
  ClashSysProxyStatus,
  ClashTestResult,
  ClashTestSite,
  CompileView,
  CoreProbe,
  CoreStatus,
  PrismStatusView,
  RuleFileInfo,
  RuleGroups,
  ValidateView,
} from "./types";

export function clashSummary(): Promise<ClashSummary> {
  return invokeCommand<Record<string, never>, ClashSummary>("clash_summary", {});
}

export function clashStatus(): Promise<PrismStatusView> {
  return invokeCommand<Record<string, never>, PrismStatusView>("clash_status", {});
}

// ── Profiles ───────────────────────────────────────────────────────────────

export function clashProfileList(): Promise<ClashProfile[]> {
  return invokeCommand<Record<string, never>, ClashProfile[]>("clash_profile_list", {});
}

export function clashProfileRead(id: string): Promise<string> {
  return invokeCommand<{ id: string }, string>("clash_profile_read", { id });
}

export function clashProfileWrite(id: string, content: string): Promise<void> {
  return invokeCommand<{ id: string; content: string }, void>("clash_profile_write", {
    id,
    content,
  });
}

export function clashProfileCreate(name: string): Promise<string> {
  return invokeCommand<{ name: string }, string>("clash_profile_create", { name });
}

export function clashProfileDelete(id: string): Promise<void> {
  return invokeCommand<{ id: string }, void>("clash_profile_delete", { id });
}

export function clashProfileSelect(id: string): Promise<void> {
  return invokeCommand<{ id: string }, void>("clash_profile_select", { id });
}

export function clashProfileImport(path: string): Promise<string> {
  return invokeCommand<{ path: string }, string>("clash_profile_import", { path });
}

// ── Prism rule files ───────────────────────────────────────────────────────

export function clashRuleList(): Promise<RuleFileInfo[]> {
  return invokeCommand<Record<string, never>, RuleFileInfo[]>("clash_rule_list", {});
}

export function clashRuleRead(filename: string): Promise<string> {
  return invokeCommand<{ filename: string }, string>("clash_rule_read", { filename });
}

export function clashRuleWrite(filename: string, content: string): Promise<void> {
  return invokeCommand<{ filename: string; content: string }, void>("clash_rule_write", {
    filename,
    content,
  });
}

export function clashRuleCreate(name: string): Promise<string> {
  return invokeCommand<{ name: string }, string>("clash_rule_create", { name });
}

export function clashRuleDelete(filename: string): Promise<void> {
  return invokeCommand<{ filename: string }, void>("clash_rule_delete", { filename });
}

export function clashRuleRename(filename: string, newName: string): Promise<string> {
  return invokeCommand<{ filename: string; newName: string }, string>("clash_rule_rename", {
    filename,
    newName,
  });
}

export function clashRuleToggle(filename: string, enabled: boolean): Promise<boolean> {
  return invokeCommand<{ filename: string; enabled: boolean }, boolean>("clash_rule_toggle", {
    filename,
    enabled,
  });
}

export function clashRuleImportText(name: string, content: string): Promise<string> {
  return invokeCommand<{ name: string; content: string }, string>("clash_rule_import_text", {
    name,
    content,
  });
}

export function clashGroupList(): Promise<RuleGroups> {
  return invokeCommand<Record<string, never>, RuleGroups>("clash_group_list", {});
}

export function clashGroupSave(groups: RuleGroups): Promise<void> {
  return invokeCommand<{ groups: RuleGroups }, void>("clash_group_save", { groups });
}

// ── Compile ────────────────────────────────────────────────────────────────

export function clashPreview(): Promise<CompileView> {
  return invokeCommand<Record<string, never>, CompileView>("clash_preview", {});
}

export function clashApply(validate: boolean): Promise<ApplyView> {
  return invokeCommand<{ validate: boolean }, ApplyView>("clash_apply", { validate });
}

export function clashOutputRead(): Promise<string> {
  return invokeCommand<Record<string, never>, string>("clash_output_read", {});
}

// ── Core ───────────────────────────────────────────────────────────────────

export function clashCoreStatus(): Promise<CoreStatus> {
  return invokeCommand<Record<string, never>, CoreStatus>("clash_core_status", {});
}

export function clashCoreStart(): Promise<number> {
  return invokeCommand<Record<string, never>, number>("clash_core_start", {});
}

export function clashCoreStop(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("clash_core_stop", {});
}

export function clashCoreValidate(content: string): Promise<ValidateView> {
  return invokeCommand<{ content: string }, ValidateView>("clash_core_validate", { content });
}

export function clashCoreVersion(): Promise<CoreProbe> {
  return invokeCommand<Record<string, never>, CoreProbe>("clash_core_version", {});
}

/** Uptime and memory of the core process; null fields when it is not running. */
export function clashCoreMetrics(): Promise<ClashCoreMetrics> {
  return invokeCommand<Record<string, never>, ClashCoreMetrics>("clash_core_metrics", {});
}

/** A geo lookup of the current exit address, through the core when it runs. */
export function clashIpInfo(): Promise<ClashIpInfo> {
  return invokeCommand<Record<string, never>, ClashIpInfo>("clash_ip_info", {});
}

// ── Subscriptions ──────────────────────────────────────────────────────────

export function clashSubscriptionList(): Promise<ClashSubscription[]> {
  return invokeCommand<Record<string, never>, ClashSubscription[]>("clash_subscription_list", {});
}

export function clashSubscriptionAdd(name: string, url: string): Promise<ClashSubscription> {
  return invokeCommand<{ name: string; url: string }, ClashSubscription>("clash_subscription_add", {
    name,
    url,
  });
}

export function clashSubscriptionUpdate(name: string): Promise<ClashSubscription> {
  return invokeCommand<{ name: string }, ClashSubscription>("clash_subscription_update", {
    name,
  });
}

export function clashSubscriptionRemove(name: string): Promise<void> {
  return invokeCommand<{ name: string }, void>("clash_subscription_remove", { name });
}

// ── Connections ────────────────────────────────────────────────────────────

export function clashConnections(): Promise<ClashConnectionsView> {
  return invokeCommand<Record<string, never>, ClashConnectionsView>("clash_connections", {});
}

export function clashConnectionClose(id: string): Promise<void> {
  return invokeCommand<{ id: string }, void>("clash_connection_close", { id });
}

export function clashConnectionsCloseAll(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("clash_connections_close_all", {});
}

// ── Proxies ────────────────────────────────────────────────────────────────

export function clashProxies(): Promise<ClashProxiesView> {
  return invokeCommand<Record<string, never>, ClashProxiesView>("clash_proxies", {});
}

export function clashProxySelect(group: string, name: string): Promise<void> {
  return invokeCommand<{ group: string; name: string }, void>("clash_proxy_select", {
    group,
    name,
  });
}

/** Measured in milliseconds by the core itself; a dead node rejects. */
export function clashProxyDelay(name: string): Promise<number> {
  return invokeCommand<{ name: string }, number>("clash_proxy_delay", { name });
}

// ── Routing rules ──────────────────────────────────────────────────────────

export function clashRules(): Promise<ClashRulesView> {
  return invokeCommand<Record<string, never>, ClashRulesView>("clash_rules", {});
}

// ── Runtime ────────────────────────────────────────────────────────────────

export function clashRuntime(): Promise<ClashRuntime> {
  return invokeCommand<Record<string, never>, ClashRuntime>("clash_runtime", {});
}

export function clashSetMode(mode: string): Promise<void> {
  return invokeCommand<{ mode: string }, void>("clash_set_mode", { mode });
}

export function clashSysProxy(): Promise<ClashSysProxyStatus> {
  return invokeCommand<Record<string, never>, ClashSysProxyStatus>("clash_sys_proxy", {});
}

export function clashSysProxySet(enabled: boolean): Promise<void> {
  return invokeCommand<{ enabled: boolean }, void>("clash_sys_proxy_set", { enabled });
}

// ── Logs ───────────────────────────────────────────────────────────────────

/** The tail of the core's log file; the command caps the count at 500. */
export function clashLogs(limit = 300): Promise<ClashLogsView> {
  return invokeCommand<{ limit: number }, ClashLogsView>("clash_logs", { limit });
}

// ── Site tests ─────────────────────────────────────────────────────────────

/** The saved sites, or the defaults until the list has been edited once. */
export function clashTestList(): Promise<ClashTestSite[]> {
  return invokeCommand<Record<string, never>, ClashTestSite[]>("clash_test_list", {});
}

/** Replace the whole list; the page owns the order and the identifiers. */
export function clashTestSave(sites: ClashTestSite[]): Promise<void> {
  return invokeCommand<{ sites: ClashTestSite[] }, void>("clash_test_save", { sites });
}

/** Fetch one URL through the core; a site that cannot be reached rejects. */
export function clashTestUrl(url: string): Promise<ClashTestResult> {
  return invokeCommand<{ url: string }, ClashTestResult>("clash_test_url", { url });
}

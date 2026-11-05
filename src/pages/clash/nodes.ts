import { useEffect, useRef, useState } from "react";
import type {
  ClashConnection,
  ClashProxiesView,
  ClashProxyGroup,
  ClashProxyNode,
} from "@/commands";

/** Connections sampled per observation, most recent first. */
export const MAX_SAMPLE = 30;
/** Fewest connections one group must carry before it can be reported. */
export const MIN_FREQ = 3;
/** Smallest share of proxied connections that group must hold. */
export const MIN_RATIO = 0.3;
/** Identical observations needed before the result is shown. */
export const CONFIRM_TICKS = 3;

/** Built-in exits that carry no proxy; matched exactly by name. */
const NON_PROXY_NAMES = new Set([
  "DIRECT",
  "REJECT",
  "REJECTDROP",
  "REJECT-DROP",
  "PASS",
  "PASS-RULE",
  "COMPATIBLE",
  "DNS",
]);

/** Proxy kinds that, under a config's own name, are still plain direct/reject exits. */
const NON_PROXY_KINDS = new Set([
  "DIRECT",
  "REJECT",
  "REJECTDROP",
  "PASS",
  "PASSRULE",
  "COMPATIBLE",
  "DNS",
]);

const PROTOCOL_ABBR: Record<string, string> = {
  SHADOWSOCKS: "SS",
  SHADOWSOCKSR: "SSR",
  TROJAN: "Trojan",
  VMESS: "VMess",
  VLESS: "VLESS",
  HYSTERIA: "Hy",
  HYSTERIA2: "Hy2",
  TUIC: "TUIC",
  JUICITY: "Juicity",
  WIREGUARD: "WG",
  SNELL: "Snell",
  ANYTLS: "AnyTLS",
  SOCKS5: "SOCKS5",
  HTTP: "HTTP",
  SSH: "SSH",
  SOCKS: "SOCKS",
  MIERU: "Mieru",
  MASQUE: "MASQUE",
  SUDOKU: "Sudoku",
  TRUSTTUNNEL: "TrustTunnel",
  KCP: "KCP",
  KCPTUN: "KCPTun",
  DIRECT: "Direct",
  REJECT: "Reject",
  REJECTDROP: "Reject",
  DNS: "DNS",
  PASS: "Pass",
  COMPATIBLE: "Compatible",
};

const TRANSPORT: Record<string, string> = {
  TUIC: "QUIC",
  HYSTERIA: "QUIC",
  HYSTERIA2: "QUIC",
  JUICITY: "QUIC",
  MASQUE: "QUIC",
  WIREGUARD: "UDP",
  KCP: "UDP",
  KCPTUN: "UDP",
  ANYTLS: "TCP",
  TROJAN: "TCP",
  VLESS: "TCP",
  VMESS: "TCP",
  SHADOWSOCKS: "TCP",
  SHADOWSOCKSR: "TCP",
  SNELL: "TCP",
  HTTP: "TCP",
  SOCKS5: "TCP",
  SOCKS: "TCP",
  SSH: "TCP",
  MIERU: "TCP",
  TRUSTTUNNEL: "TCP",
  SUDOKU: "TCP",
};

/** The node traffic actually leaves through, as far as the live connections show. */
export type ObservedNode = {
  name: string;
  /** The group the connection actually belongs to. */
  group: string | null;
  kind: string;
  delay: number | null;
  alive: boolean;
};

export type NodeEntry = {
  node: ClashProxyNode;
  /** The Selector that owns this node when there is one; automatic groups otherwise. */
  group: ClashProxyGroup;
};

function normalizeKind(kind: string): string {
  return kind.toUpperCase().replace(/[-_ ]/g, "");
}

/** `TUIC · QUIC`, `SS · TCP`, `VMess · TCP` — what the card's meta row says. */
export function protocolLabel(kind: string): string {
  if (!kind) return "";
  const key = normalizeKind(kind);
  const abbr = PROTOCOL_ABBR[key] ?? kind;
  const transport = TRANSPORT[key];
  return transport ? `${abbr} · ${transport}` : abbr;
}

/** Faster is better; a node nobody has probed, or one that is down, stays grey. */
export function toneClass(node: { alive: boolean; delay: number | null }): string {
  if (!node.alive || node.delay === null) return "text-muted-foreground/70";
  if (node.delay < 200) return "text-emerald-600 dark:text-emerald-400";
  if (node.delay < 500) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function isSelectable(group: ClashProxyGroup): boolean {
  return group.kind === "Selector";
}

/**
 * The groups a mode routes through. Rule mode shows the profile's own groups —
 * GLOBAL is the list of everything and would just repeat them — global mode
 * shows only GLOBAL, and direct mode sends traffic straight out, so no group is
 * in use at all.
 */
export function groupsForMode(view: ClashProxiesView | null, mode: string): ClashProxyGroup[] {
  if (!view) return [];
  if (mode === "global") return view.groups.filter((group) => group.name === "GLOBAL");
  if (mode === "rule") return view.groups.filter((group) => group.name !== "GLOBAL");
  return [];
}

function groupByName(view: ClashProxiesView | null, name: string): ClashProxyGroup | null {
  return view?.groups.find((group) => group.name === name) ?? null;
}

function memberOf(view: ClashProxiesView | null, name: string): ClashProxyNode | null {
  for (const group of view?.groups ?? []) {
    const member = group.members.find((item) => item.name === name);
    if (member) return member;
  }
  return null;
}

function isNonProxyKind(kind: string): boolean {
  return NON_PROXY_KINDS.has(normalizeKind(kind));
}

/** A DIRECT/REJECT-style exit: built in by name, or a local outbound of such a kind. */
export function isNonProxyExit(name: string, view: ClashProxiesView | null): boolean {
  if (NON_PROXY_NAMES.has(name.trim().toUpperCase())) return true;
  const member = memberOf(view, name);
  return member !== null && isNonProxyKind(member.kind);
}

/** A group the user can write to and that is worth reporting as the traffic source. */
function isObservableGroup(view: ClashProxiesView | null, name: string): boolean {
  const group = groupByName(view, name);
  if (!group || !isSelectable(group)) return false;
  const upper = name.toUpperCase();
  return !NON_PROXY_NAMES.has(upper) && !upper.includes("DIRECT");
}

function offersProxy(view: ClashProxiesView | null, group: ClashProxyGroup): boolean {
  return group.members.some((member) => !isNonProxyExit(member.name, view));
}

/** Follow a group's `now` down to the node that would carry the traffic. */
export function resolveLeaf(view: ClashProxiesView | null, name: string): string {
  const seen = new Set([name]);
  let current = name;
  for (;;) {
    const group = groupByName(view, current);
    if (!group || !group.now || seen.has(group.now)) return current;
    seen.add(group.now);
    current = group.now;
  }
}

/** Whether `node` is reachable from `group`, directly or through nested groups. */
export function groupContains(view: ClashProxiesView | null, group: string, node: string): boolean {
  const seen = new Set<string>();
  const stack = [group];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const current = groupByName(view, name);
    if (!current) continue;
    if (current.members.some((member) => member.name === node)) return true;
    stack.push(...current.members.map((member) => member.name));
  }
  return false;
}

/**
 * Real nodes only: members that are themselves groups and DIRECT/REJECT-style
 * exits are dropped, and a node reachable through several groups appears once —
 * bound to the first Selector that lists it, so a click always has somewhere to go.
 *
 * `groups` narrows the scan to the groups a mode shows; the group names still
 * come from the whole view, so a nested group is never mistaken for a node.
 */
export function collectNodes(
  view: ClashProxiesView | null,
  groups: ClashProxyGroup[] = view?.groups ?? []
): NodeEntry[] {
  if (!view) return [];
  const groupNames = new Set(view.groups.map((group) => group.name));
  const byName = new Map<string, NodeEntry>();
  for (const group of groups) {
    for (const member of group.members) {
      if (groupNames.has(member.name)) continue;
      if (NON_PROXY_NAMES.has(member.name.trim().toUpperCase())) continue;
      if (isNonProxyKind(member.kind)) continue;
      const existing = byName.get(member.name);
      if (!existing) {
        byName.set(member.name, { node: member, group });
      } else if (!isSelectable(existing.group) && isSelectable(group)) {
        // A Selector can act on the click; an automatic group cannot.
        byName.set(member.name, { node: member, group });
      }
    }
  }
  // The node traffic is leaving through comes first.
  return [...byName.values()].sort((a, b) => {
    const aActive = a.group.now === a.node.name ? 0 : 1;
    const bActive = b.group.now === b.node.name ? 0 : 1;
    return aActive - bActive || a.node.name.localeCompare(b.node.name);
  });
}

function observedNode(view: ClashProxiesView | null, name: string, group: string | null) {
  const member = memberOf(view, name);
  return {
    name,
    group,
    kind: member?.kind ?? "",
    delay: member?.alive ? (member.delay ?? null) : null,
    alive: member?.alive ?? true,
  } satisfies ObservedNode;
}

/**
 * Derive the group and node the live connections actually leave through.
 *
 * `chains[0]` is the exit node: measured against a running core, a proxied
 * request reported `["<node>", "<url-test group>", "<selector group>"]`.
 */
export function observedCandidate(
  connections: ClashConnection[],
  view: ClashProxiesView | null
): ObservedNode | null {
  if (connections.length === 0 || !view) return null;
  const sample = connections.slice(-MAX_SAMPLE);
  const groupFreq = new Map<string, number>();
  const nodeFreq = new Map<string, Map<string, number>>();
  let proxied = 0;

  for (const connection of sample) {
    const chains = connection.chains;
    const exit = chains[0] ?? "";
    if (!exit) continue;
    const chainGroup = chains.find((name) => isObservableGroup(view, name)) ?? null;

    if (isNonProxyExit(exit, view)) {
      // Traffic leaving DIRECT says nothing about the chosen node, but it still
      // counts when a selector that also offers proxies picked it.
      const offered = chains.some((name) => {
        const group = groupByName(view, name);
        return group !== null && isObservableGroup(view, name) && offersProxy(view, group);
      });
      if (offered) proxied += 1;
      continue;
    }

    proxied += 1;
    if (!chainGroup) continue;
    groupFreq.set(chainGroup, (groupFreq.get(chainGroup) ?? 0) + 1);
    const nodes = nodeFreq.get(chainGroup) ?? new Map<string, number>();
    nodes.set(exit, (nodes.get(exit) ?? 0) + 1);
    nodeFreq.set(chainGroup, nodes);
  }

  let topGroup: string | null = null;
  let topCount = 0;
  for (const [name, count] of groupFreq) {
    if (count > topCount) {
      topGroup = name;
      topCount = count;
    }
  }
  if (!topGroup || proxied === 0) return null;
  if (topCount < MIN_FREQ || topCount / proxied < MIN_RATIO) return null;

  let topNode: string | null = null;
  let topNodeCount = 0;
  for (const [name, count] of nodeFreq.get(topGroup) ?? []) {
    if (count > topNodeCount) {
      topNode = name;
      topNodeCount = count;
    }
  }
  return topNode ? observedNode(view, topNode, topGroup) : null;
}

/**
 * The confirmed observation, so a single unusual connection does not move the
 * dashboard. Identical candidates must arrive CONFIRM_TICKS times in a row.
 */
export function useObservedNode(
  connections: ClashConnection[],
  view: ClashProxiesView | null
): ObservedNode | null {
  const [confirmed, setConfirmed] = useState<ObservedNode | null>(null);
  const lastKey = useRef<string | null>(null);
  const ticks = useRef(0);

  useEffect(() => {
    const candidate = observedCandidate(connections, view);
    if (!candidate) {
      lastKey.current = null;
      ticks.current = 0;
      setConfirmed(null);
      return;
    }
    const key = `${candidate.group ?? ""}\u0000${candidate.name}`;
    if (key === lastKey.current) ticks.current += 1;
    else {
      lastKey.current = key;
      ticks.current = 1;
    }
    if (ticks.current < CONFIRM_TICKS) return;
    setConfirmed((prev) =>
      prev && prev.name === candidate.name && prev.group === candidate.group ? prev : candidate
    );
  }, [connections, view]);

  return confirmed;
}

/**
 * What the dashboard names: the confirmed observation while it still exists,
 * otherwise the first Selector's current leaf, otherwise any group's leaf.
 * A group currently pointing at DIRECT is skipped — that is not a proxy node.
 */
export function displayNode(
  view: ClashProxiesView | null,
  confirmed: ObservedNode | null
): ObservedNode | null {
  if (!view) return confirmed;
  if (confirmed) {
    const member = memberOf(view, confirmed.name);
    const belongs = confirmed.group ? groupContains(view, confirmed.group, confirmed.name) : true;
    if (member && belongs) return observedNode(view, confirmed.name, confirmed.group);
  }

  const candidates = view.groups
    .filter((group) => isSelectable(group) && group.now)
    .concat(view.groups.filter((group) => !isSelectable(group) && group.now));
  for (const group of candidates) {
    const leaf = resolveLeaf(view, group.now);
    if (isNonProxyExit(leaf, view)) continue;
    const member = memberOf(view, leaf);
    if (!member) continue;
    return observedNode(view, leaf, group.name);
  }
  return null;
}

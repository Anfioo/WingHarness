import { parseRemote, pickRemote } from "../remotes";
import type { RemoteInfo } from "../types";

export function pickForgeRemote(
  remotes: RemoteInfo[],
  headUpstream: string | null
): RemoteInfo | null {
  return pickRemote(remotes, headUpstream);
}

export type ForgeKind = "github" | "gitlab" | "bitbucket" | "bitbucket-server";

export interface ForgeRemote {
  kind: ForgeKind;
  scheme: string;
  host: string;
  owner: string;
  repo: string;
  webUrl: string;
}

const DECLARED_HOSTS = new Map<string, ForgeKind>();

const hostKey = (host: string) => host.toLowerCase().split(":")[0];

export function registerForgeHosts(hosts: ReadonlyArray<{ host: string; kind: ForgeKind }>): void {
  DECLARED_HOSTS.clear();
  for (const { host, kind } of hosts) {
    const key = hostKey(host);
    if (key) DECLARED_HOSTS.set(key, kind);
  }
}

export function declaredForgeKind(host: string): ForgeKind | null {
  return DECLARED_HOSTS.get(hostKey(host)) ?? null;
}

export function forgeKindForProvider(provider: string): ForgeKind | null {
  const p = provider.toLowerCase();
  if (p.startsWith("github")) return "github";
  if (p.startsWith("gitlab")) return "gitlab";
  if (p === "bitbucket-server") return "bitbucket-server";
  if (p.startsWith("bitbucket")) return "bitbucket";
  return null;
}

export function detectedForgeKind(hostname: string): ForgeKind | null {
  if (hostname.includes("github")) return "github";
  if (hostname === "bitbucket.org") return "bitbucket";
  if (hostname.includes("bitbucket")) return "bitbucket-server";
  if (hostname.includes("gitlab")) return "gitlab";
  return declaredForgeKind(hostname);
}

function shapeRemote(
  kind: ForgeKind,
  segments: string[],
  base: { scheme: string; host: string; webUrl: string }
): ForgeRemote | null {
  if (kind === "github" || kind === "bitbucket") {
    if (segments.length !== 2) return null;
    return { kind, owner: segments[0], repo: segments[1], ...base };
  }
  if (kind === "bitbucket-server") {
    if (segments[0] !== "scm" || segments.length < 3) return null;
    return { kind, owner: segments[1], repo: segments.slice(2).join("/"), ...base };
  }
  if (segments.length < 2) return null;
  return {
    kind,
    owner: segments.slice(0, -1).join("/"),
    repo: segments[segments.length - 1],
    ...base,
  };
}

export function parseForgeRemote(url: string): ForgeRemote | null {
  const remote = parseRemote(url);
  if (!remote) return null;
  const hostname = remote.host.split(":")[0];
  const segments = remote.path.split("/").filter(Boolean);
  const webUrl = `${remote.scheme}://${remote.host}/${remote.path}`;
  const base = { scheme: remote.scheme, host: remote.host, webUrl };
  const kind = detectedForgeKind(hostname);
  return kind ? shapeRemote(kind, segments, base) : null;
}

export interface ForgeTarget {
  name: string;
  remote: ForgeRemote;
}

export function forgeTargets(remotes: RemoteInfo[], source: ForgeRemote): ForgeTarget[] {
  const seen = new Set<string>();
  const out: ForgeTarget[] = [];
  for (const entry of remotes) {
    const remote = parseForgeRemote(entry.url);
    if (!remote || remote.kind !== source.kind) continue;
    if (remote.host.toLowerCase() !== source.host.toLowerCase()) continue;
    const key = `${remote.owner}/${remote.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: entry.name, remote });
  }
  return out;
}

export function defaultForgeTarget(targets: ForgeTarget[], sourceName: string): string {
  const upstream = targets.find((t) => t.name === "upstream");
  if (upstream && upstream.name !== sourceName) return upstream.name;
  return targets.find((t) => t.name === sourceName)?.name ?? targets[0]?.name ?? sourceName;
}

export function sameForgeRepo(a: ForgeRemote, b: ForgeRemote): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

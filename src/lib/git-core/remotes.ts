export interface NamedRemote {
  name: string;
}

export interface ParsedRemote {
  scheme: string;
  host: string;
  path: string;
}

export function parseRemote(url: string): ParsedRemote | null {
  const trimmed = url
    .trim()
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  const web = trimmed.match(/^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (web) return { scheme: web[1], host: web[2], path: web[3] };
  const ssh = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
  if (ssh) return { scheme: "https", host: ssh[1], path: ssh[2] };
  const scp = trimmed.match(/^(?:[^@/]+@)([^:/]+):(.+)$/);
  if (scp) return { scheme: "https", host: scp[1], path: scp[2] };
  return null;
}

export const upstreamRemoteOf = (headUpstream: string | null | undefined): string | null => {
  const name = headUpstream?.split("/")[0];
  return name ? name : null;
};

export function pickRemote<T extends NamedRemote>(
  remotes: T[],
  headUpstream: string | null | undefined
): T | null {
  if (remotes.length === 0) return null;
  const upstreamRemote = upstreamRemoteOf(headUpstream);
  if (upstreamRemote) {
    const match = remotes.find((remote) => remote.name === upstreamRemote);
    if (match) return match;
  }
  return remotes.find((remote) => remote.name === "origin") ?? remotes[0];
}

export const pushSetsUpstream = (
  headUpstream: string | null | undefined,
  remoteName: string
): boolean => {
  const upstreamRemote = upstreamRemoteOf(headUpstream);
  return upstreamRemote === null || upstreamRemote === remoteName;
};

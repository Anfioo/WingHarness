import { parseRemote } from "./remotes";

export function remoteWebUrl(remoteUrl: string): string | null {
  const remote = parseRemote(remoteUrl);
  if (!remote) return null;
  const hostname = remote.host.split(":")[0];
  const segments = remote.path.split("/");
  if (
    hostname !== "bitbucket.org" &&
    hostname.includes("bitbucket") &&
    segments[0] === "scm" &&
    segments.length >= 3
  ) {
    const project = segments[1].toUpperCase();
    const repo = segments.slice(2).join("/");
    return `${remote.scheme}://${remote.host}/projects/${project}/repos/${repo}/browse`;
  }
  return `${remote.scheme}://${remote.host}/${remote.path}`;
}

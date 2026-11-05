import i18n from "@/i18n";
import { pullRequestUrl } from "@/lib/git-core";

export function timeAgo(unixSeconds: number): string {
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 60) return i18n.t("gitRepo.extras.timeAgo.now");
  if (diff < 3600)
    return i18n.t("gitRepo.extras.timeAgo.minutes", { count: Math.floor(diff / 60) });
  if (diff < 86400)
    return i18n.t("gitRepo.extras.timeAgo.hours", { count: Math.floor(diff / 3600) });
  if (diff < 86400 * 30)
    return i18n.t("gitRepo.extras.timeAgo.days", { count: Math.floor(diff / 86400) });
  if (diff < 86400 * 365)
    return i18n.t("gitRepo.extras.timeAgo.months", {
      count: Math.floor(diff / (86400 * 30)),
    });
  return i18n.t("gitRepo.extras.timeAgo.years", {
    count: Math.floor(diff / (86400 * 365)),
  });
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function avatarHue(email: string): number {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export const isMac =
  typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

export function modKey(): string {
  return isMac ? "⌘" : "Ctrl";
}

export function shortenHome(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/, "~");
}

const PATH_SEPARATORS = /[/\\]/;

export function basename(path: string): string {
  const parts = path.split(PATH_SEPARATORS).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : "";
}

export function capCount(count: number, max = 99): string {
  return count > max ? `${max}+` : String(count);
}

const DEFAULT_BRANCHES = new Set(["main", "master"]);

export function currentPullRequestUrl(
  repo: { headBranch: string | null; isDetached: boolean } | null,
  remoteUrl: string | undefined
): string | null {
  if (!repo || repo.isDetached || !repo.headBranch || !remoteUrl) return null;
  if (DEFAULT_BRANCHES.has(repo.headBranch)) return null;
  return pullRequestUrl(remoteUrl, repo.headBranch);
}

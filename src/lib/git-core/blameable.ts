import type { FileStatus } from "@/lib/git-core/types";

export function hasCommittedHistory(file: Pick<FileStatus, "staged" | "unstaged">): boolean {
  return file.staged !== "new" && file.unstaged !== "new" && file.unstaged !== "untracked";
}

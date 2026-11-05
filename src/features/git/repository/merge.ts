import { toast } from "sonner";
import i18n from "@/i18n";
import { mergeAbort } from "@/commands";
import { confirmDialog } from "@/components/confirm";
import { useRepo } from "@/features/git/repository-store";

export async function abortMergeFlow(path: string): Promise<void> {
  const ok = await confirmDialog({
    title: i18n.t("gitRepo.sidebar.merge.abortTitle"),
    description: i18n.t("gitRepo.sidebar.merge.abortDescription"),
    confirmLabel: i18n.t("gitRepo.sidebar.merge.abortLabel"),
    destructive: true,
  });
  if (!ok) return;
  try {
    await mergeAbort(path);
  } catch (error) {
    toast.error(
      i18n.t("gitRepo.sidebar.merge.abortFailed", {
        error: (error as { message?: string })?.message ?? String(error),
      })
    );
    return;
  }
  toast.success(i18n.t("gitRepo.sidebar.merge.aborted"));
  try {
    await useRepo.getState().refresh();
  } catch (error) {
    toast.error(
      i18n.t("gitRepo.sidebar.merge.refreshFailed", {
        error: (error as { message?: string })?.message ?? String(error),
      })
    );
  }
}

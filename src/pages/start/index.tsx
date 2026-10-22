import { FileSearch, FolderKanban, NotebookPen, SquareTerminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";

// The pages the landing page promotes, in the order it lists them.
const shortcuts: { path: string; icon: LucideIcon; key: string }[] = [
  { path: "/project", icon: FolderKanban, key: "project" },
  { path: "/local-terminal", icon: SquareTerminal, key: "terminal" },
  { path: "/notes", icon: NotebookPen, key: "notes" },
  { path: "/file-preview", icon: FileSearch, key: "filePreview" },
];

export default function StartPage() {
  const { t } = useAppTranslation();
  const { navigate } = useRouter();

  return (
    <AppShell>
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 py-10">
        <header className="flex flex-col gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">{t("start.title")}</h2>
          <p className="text-muted-foreground text-sm leading-6">{t("start.subtitle")}</p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2">
          {shortcuts.map(({ path, icon: Icon, key }) => (
            <button
              key={key}
              type="button"
              onClick={() => navigate(path)}
              className="border-border bg-card hover:border-primary/40 hover:bg-accent/40 flex flex-col gap-2 rounded-xl border p-5 text-left shadow-sm transition-colors"
            >
              <div className="bg-muted flex size-8 items-center justify-center rounded-lg">
                <Icon className="size-4" />
              </div>
              <span className="text-sm font-medium">{t(`start.shortcuts.${key}.title`)}</span>
              <span className="text-muted-foreground text-xs leading-5">
                {t(`start.shortcuts.${key}.description`)}
              </span>
            </button>
          ))}
        </div>
      </section>
    </AppShell>
  );
}

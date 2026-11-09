import { useCallback, useEffect, useMemo, useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import {
  FileCode,
  FilePlus2,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  ScrollText,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import {
  clashApply,
  clashPreview,
  clashProfileCreate,
  clashProfileDelete,
  clashProfileImport,
  clashProfileRead,
  clashProfileSelect,
  clashProfileWrite,
  clashRuleCreate,
  clashRuleDelete,
  clashRuleImportText,
  clashRuleRead,
  clashRuleRename,
  clashRuleToggle,
  clashRuleWrite,
  type ClashCompileView,
  type ClashProfile,
  type ClashRuleFileInfo,
  type ClashSummary,
} from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/code-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { languageFor } from "./languages";
import {
  Empty,
  IconButton,
  PromptDialog,
  Segmented,
  formatBytes,
  type PromptState,
} from "./shared";

type Kind = "rules" | "profiles";
type View = "edit" | "output";

export function SettingsTab({
  summary,
  refresh,
}: {
  summary: ClashSummary | null;
  refresh: () => Promise<void>;
}) {
  const { t } = useAppTranslation();

  const [tab, setTab] = useState<Kind>("rules");
  const [view, setView] = useState<View>("edit");
  const [selected, setSelected] = useState<{ kind: Kind; id: string } | null>(null);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ClashCompileView | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: Kind; id: string } | null>(null);

  const dirty = content !== saved;

  const openItem = useCallback(async (kind: Kind, id: string) => {
    setSelected({ kind, id });
    setView("edit");
    try {
      const text = kind === "rules" ? await clashRuleRead(id) : await clashProfileRead(id);
      setContent(text);
      setSaved(text);
    } catch (error) {
      console.error("Failed to read file:", error);
      toast.error(String(error));
    }
  }, []);

  // Land on something rather than an empty editor.
  const firstItem = useMemo(() => {
    if (!summary) return null;
    if (tab === "rules") {
      return summary.rules[0] ? { kind: "rules" as Kind, id: summary.rules[0].filename } : null;
    }
    return summary.profiles[0] ? { kind: "profiles" as Kind, id: summary.profiles[0].id } : null;
  }, [summary, tab]);

  useEffect(() => {
    if (selected || !firstItem) return;
    void openItem(firstItem.kind, firstItem.id);
  }, [firstItem, openItem, selected]);

  const save = useCallback(async () => {
    if (!selected || !dirty) return;
    try {
      if (selected.kind === "rules") {
        await clashRuleWrite(selected.id, content);
      } else {
        await clashProfileWrite(selected.id, content);
      }
      setSaved(content);
      toast.success(t("clash.messages.saved"));
    } catch (error) {
      toast.error(String(error));
    }
  }, [content, dirty, selected, t]);

  const compile = useCallback(
    async (mode: "preview" | "apply") => {
      if (dirty) {
        toast.info(t("clash.editor.saveFirst"));
        return;
      }
      setBusy(mode);
      try {
        const next = mode === "preview" ? await clashPreview() : await clashApply(true);
        setResult(next);
        setView("output");
        toast.success(
          mode === "preview" ? t("clash.messages.previewed") : t("clash.messages.applied")
        );
        await refresh();
      } catch (error) {
        toast.error(String(error));
      } finally {
        setBusy(null);
      }
    },
    [dirty, refresh, t]
  );

  const askName = useCallback((title: string, onSubmit: (value: string) => void) => {
    setPrompt({ title, value: "", onSubmit });
  }, []);

  const createItem = useCallback(() => {
    if (tab === "rules") {
      askName(t("clash.prompts.newRule"), (name) => {
        void (async () => {
          try {
            const filename = await clashRuleCreate(name);
            await refresh();
            await openItem("rules", filename);
          } catch (error) {
            toast.error(String(error));
          }
        })();
      });
    } else {
      askName(t("clash.prompts.newProfile"), (name) => {
        void (async () => {
          try {
            const id = await clashProfileCreate(name);
            await refresh();
            await openItem("profiles", id);
          } catch (error) {
            toast.error(String(error));
          }
        })();
      });
    }
  }, [askName, openItem, refresh, t, tab]);

  const importProfile = useCallback(async () => {
    const picked = await pickFile({
      multiple: false,
      filters: [{ name: "YAML", extensions: ["yaml", "yml"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const id = await clashProfileImport(picked);
      await refresh();
      await openItem("profiles", id);
    } catch (error) {
      toast.error(String(error));
    }
  }, [openItem, refresh]);

  const importRules = useCallback(() => {
    setPrompt({
      title: t("clash.prompts.importRules"),
      value: "",
      multiline: true,
      onSubmit: (text) => {
        void (async () => {
          try {
            const filename = await clashRuleImportText("imported", text);
            await refresh();
            await openItem("rules", filename);
          } catch (error) {
            toast.error(String(error));
          }
        })();
      },
    });
  }, [openItem, refresh, t]);

  const renameItem = useCallback(() => {
    if (!selected || selected.kind !== "rules") return;
    askName(t("clash.prompts.rename"), (name) => {
      void (async () => {
        try {
          const filename = await clashRuleRename(selected.id, name);
          await refresh();
          await openItem("rules", filename);
        } catch (error) {
          toast.error(String(error));
        }
      })();
    });
  }, [askName, openItem, refresh, selected, t]);

  const deleteItem = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      if (pendingDelete.kind === "rules") {
        await clashRuleDelete(pendingDelete.id);
      } else {
        await clashProfileDelete(pendingDelete.id);
      }
      setPendingDelete(null);
      setSelected(null);
      setContent("");
      setSaved("");
      toast.success(t("clash.messages.deleted"));
      await refresh();
    } catch (error) {
      toast.error(String(error));
    }
  }, [pendingDelete, refresh, t]);

  const toggleRule = useCallback(
    async (file: ClashRuleFileInfo, enabled: boolean) => {
      try {
        await clashRuleToggle(file.filename, enabled);
        await refresh();
      } catch (error) {
        toast.error(String(error));
      }
    },
    [refresh]
  );

  const selectProfile = useCallback(
    async (profile: ClashProfile) => {
      try {
        await clashProfileSelect(profile.id);
        toast.success(t("clash.messages.saved"));
        await refresh();
      } catch (error) {
        toast.error(String(error));
      }
    },
    [refresh, t]
  );

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col border-r">
        <div className="flex flex-wrap items-center gap-1 border-b px-2.5 py-2">
          <Segmented
            value={tab}
            onChange={(next) => {
              setTab(next);
              setSelected(null);
            }}
            options={[
              { value: "rules", label: t("clash.tabs.rules") },
              { value: "profiles", label: t("clash.tabs.profiles") },
            ]}
          />
          <div className="ml-auto flex items-center">
            <IconButton title={t("clash.actions.new")} onClick={createItem}>
              <FilePlus2 className="size-3.5" />
            </IconButton>
            <IconButton
              title={
                tab === "rules" ? t("clash.actions.importRules") : t("clash.actions.importFile")
              }
              onClick={tab === "rules" ? importRules : () => void importProfile()}
            >
              <Upload className="size-3.5" />
            </IconButton>
            <IconButton title={t("clash.actions.refresh")} onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />
            </IconButton>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {tab === "rules" ? (
            summary?.rules.length ? (
              summary.rules.map((file) => (
                <RuleRow
                  key={file.filename}
                  file={file}
                  active={selected?.kind === "rules" && selected.id === file.filename}
                  onOpen={() => void openItem("rules", file.filename)}
                  onToggle={(enabled) => void toggleRule(file, enabled)}
                />
              ))
            ) : (
              <Empty icon={ScrollText} text={t("clash.empty.rules")} />
            )
          ) : summary?.profiles.length ? (
            summary.profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                active={selected?.kind === "profiles" && selected.id === profile.id}
                onOpen={() => void openItem("profiles", profile.id)}
                onUse={() => void selectProfile(profile)}
              />
            ))
          ) : (
            <Empty icon={FileText} text={t("clash.empty.profiles")} />
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
          <div className="text-muted-foreground min-w-24 flex-1 truncate text-sm">
            {selected?.id ?? "—"}
            {dirty && <Badge className="ml-2 align-middle">{t("clash.editor.unsaved")}</Badge>}
          </div>
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "edit", label: t("clash.tabs.edit") },
              { value: "output", label: t("clash.output.title") },
            ]}
          />
          <IconButton title={t("clash.actions.save")} onClick={() => void save()} disabled={!dirty}>
            <Save className="size-3.5" />
          </IconButton>
          {selected?.kind === "rules" && (
            <IconButton title={t("clash.actions.rename")} onClick={renameItem}>
              <Pencil className="size-3.5" />
            </IconButton>
          )}
          <IconButton
            title={t("clash.actions.delete")}
            onClick={() => selected && setPendingDelete(selected)}
            disabled={!selected}
          >
            <Trash2 className="size-3.5" />
          </IconButton>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void compile("preview")}
          >
            {busy === "preview" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t("clash.actions.preview")}
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void compile("apply")}>
            {busy === "apply" && <Loader2 className="size-3.5 animate-spin" />}
            {t("clash.actions.apply")}
          </Button>
        </div>

        {view === "edit" ? (
          selected ? (
            <CodeEditor
              key={selected.id}
              value={content}
              language={languageFor(selected.id)}
              onChange={setContent}
            />
          ) : (
            <Empty icon={FileCode} text={t("clash.editor.empty")} />
          )
        ) : (
          <OutputPane result={result} />
        )}
      </section>

      <PromptDialog
        state={prompt}
        onChange={(value) => setPrompt(prompt && { ...prompt, value })}
        onClose={() => setPrompt(null)}
        onConfirm={() => {
          if (!prompt) return;
          const value = prompt.value.trim();
          if (!value) return;
          prompt.onSubmit(value);
          setPrompt(null);
        }}
        labels={{ confirm: t("clash.prompts.confirm"), cancel: t("clash.prompts.cancel") }}
      />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("clash.actions.delete")}</DialogTitle>
            <DialogDescription>
              {t("clash.messages.confirmDelete", { name: pendingDelete?.id ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              {t("clash.prompts.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void deleteItem()}>
              {t("clash.prompts.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RuleRow({
  file,
  active,
  onOpen,
  onToggle,
}: {
  file: ClashRuleFileInfo;
  active: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "hover:bg-accent/60 flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm",
        active && "bg-accent text-accent-foreground"
      )}
      onClick={onOpen}
    >
      <input
        type="checkbox"
        className="accent-primary size-3.5 shrink-0"
        checked={file.enabled}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span className={cn("min-w-0 flex-1 truncate", !file.enabled && "text-muted-foreground")}>
        {file.filename.replace(/\.prism\.yaml$/, "")}
      </span>
      <span className="text-muted-foreground shrink-0 text-[11px]">{file.ruleCount}</span>
    </div>
  );
}

function ProfileRow({
  profile,
  active,
  onOpen,
  onUse,
}: {
  profile: ClashProfile;
  active: boolean;
  onOpen: () => void;
  onUse: () => void;
}) {
  return (
    <div
      className={cn(
        "hover:bg-accent/60 flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm",
        active && "bg-accent text-accent-foreground"
      )}
      onClick={onOpen}
    >
      <span
        role="radio"
        aria-checked={profile.active}
        title={profile.active ? "active" : "activate"}
        onClick={(event) => {
          event.stopPropagation();
          if (!profile.active) onUse();
        }}
        className={cn(
          "size-3 shrink-0 rounded-full border",
          profile.active ? "border-primary bg-primary" : "border-muted-foreground/50"
        )}
      />
      <span className="min-w-0 flex-1 truncate">{profile.name}</span>
      <span className="text-muted-foreground shrink-0 text-[11px]">
        {formatBytes(profile.size)}
      </span>
    </div>
  );
}

function OutputPane({ result }: { result: ClashCompileView | null }) {
  const { t } = useAppTranslation();
  if (!result) {
    return <Empty icon={Terminal} text={t("clash.output.empty")} />;
  }
  const { stats, trace } = result;
  // Only patches that actually added or removed an element are worth reading;
  // count-only patches (a changed port, say) would just repeat the header.
  const changed = trace.filter(
    (entry) => entry.diffAdded.length > 0 || entry.diffRemoved.length > 0
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs">
        <span>
          {t("clash.output.stats", {
            total: stats.totalPatches,
            ok: stats.succeeded,
            skipped: stats.skipped,
          })}
        </span>
        <span>
          {t("clash.output.changes", {
            added: stats.totalAdded,
            removed: stats.totalRemoved,
            modified: stats.totalModified,
          })}
        </span>
        <span>{(stats.totalDurationUs / 1000).toFixed(1)} ms</span>
        <span className="ml-auto hidden sm:inline">{t("clash.output.onlyChanges")}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {changed.length === 0 ? (
          <Empty icon={Terminal} text={t("clash.output.noChanges")} />
        ) : (
          <div className="divide-y">
            {changed.map((entry) => (
              <section key={entry.patchId} className="px-3 py-2.5">
                <header className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      entry.conditionMatched ? "bg-emerald-500" : "bg-muted-foreground/40"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {entry.sourceFile ?? entry.patchId}
                  </span>
                  <span className="text-muted-foreground shrink-0">{entry.opName}</span>
                  <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                    +{entry.added} −{entry.removed} ~{entry.modified}
                  </span>
                </header>
                <div className="mt-1.5 flex flex-col gap-0.5 font-mono text-xs leading-5">
                  {entry.diffRemoved.map((line, index) => (
                    <ChangeLine key={`removed-${index}`} sign="-" line={line} />
                  ))}
                  {entry.diffAdded.map((line, index) => (
                    <ChangeLine key={`added-${index}`} sign="+" line={line} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One element the compile added or removed, in the engine's own words. */
function ChangeLine({ sign, line }: { sign: "-" | "+"; line: string }) {
  return (
    <div
      className={cn(
        "flex gap-1.5 rounded px-1.5 py-0.5",
        sign === "+"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-rose-500/10 text-rose-700 dark:text-rose-400"
      )}
    >
      <span className="shrink-0 opacity-70 select-none">{sign}</span>
      <span className="min-w-0 break-all whitespace-pre-wrap">{line}</span>
    </div>
  );
}

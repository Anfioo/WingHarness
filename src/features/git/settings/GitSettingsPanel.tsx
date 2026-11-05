import { useEffect, useRef, useState, type ReactNode } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Code2,
  FolderOpen,
  GitBranch,
  Loader2,
  Palette,
  Plus,
  RefreshCw,
  Sparkles,
  Terminal,
  Trash2,
  Users,
  Wifi,
} from "lucide-react";
import { httpRequest, recentRepositories, recentSetAiInstructions } from "@/commands";
import {
  AI_PROVIDER_PRESETS,
  CLI_AGENTS,
  COMMIT_STYLE_PRESETS,
  listAiModels,
  resolveCommitPrefix,
  type AiConfig,
  type AiProviderKind,
  type CliAgentId,
  type CommitLanguage,
  type CommitStylePreset,
  type CommitPrefixRule,
} from "@/lib/git-core/ai";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useUi, type GraphColumns, type SettingsPreset } from "@/features/git/ui-store";
import { useRepo } from "@/features/git/repository-store";
import { useRepositoryPrefs } from "@/features/git/repository/store";
import { useAi } from "@/features/git/ai";
import { getAiProvider, aiConfigSignature } from "@/features/git/ai/client";
import { IdentityPanel } from "@/features/git/identity";
import { AccountsPanel } from "@/features/git/accounts";
import { shortenHome } from "@/features/git/utils";
import { useGitSettings, type SettingsSection } from "./store";
import { FontsCard } from "./FontsCard";
import { Field, SettingCard, SettingEmpty, SettingRow } from "./SettingCard";
import { useCliAgents } from "./cli-agents";
import { useEditors } from "./editors";

const SECTIONS: { id: SettingsSection; labelKey: string; icon: ReactNode }[] = [
  {
    id: "appearance",
    labelKey: "gitRepo.extras.settings.sections.appearance",
    icon: <Palette className="size-4" />,
  },
  {
    id: "git",
    labelKey: "gitRepo.extras.settings.sections.git",
    icon: <GitBranch className="size-4" />,
  },
  {
    id: "accounts",
    labelKey: "gitRepo.extras.settings.sections.accounts",
    icon: <Users className="size-4" />,
  },
  {
    id: "ai",
    labelKey: "gitRepo.extras.settings.sections.ai",
    icon: <Sparkles className="size-4" />,
  },
];

function knownAgentId(id: string): CliAgentId | null {
  return id in CLI_AGENTS ? (id as CliAgentId) : null;
}

function GraphColumnsCard() {
  const { t } = useAppTranslation();
  const graphColumns = useUi((state) => state.graphColumns);
  const setGraphColumn = useUi((state) => state.setGraphColumn);
  const graphTail = useUi((state) => state.graphTail);
  const setGraphTail = useUi((state) => state.setGraphTail);

  const columns: { key: keyof GraphColumns; labelKey: string }[] = [
    { key: "refs", labelKey: "refs" },
    { key: "author", labelKey: "author" },
    { key: "message", labelKey: "message" },
    { key: "hash", labelKey: "hash" },
    { key: "date", labelKey: "date" },
  ];

  return (
    <SettingCard
      title={t("gitRepo.extras.graphColumns.title")}
      description={t("gitRepo.extras.graphColumns.description")}
    >
      <div className="divide-border flex flex-col divide-y">
        {columns.map(({ key, labelKey }) => (
          <SettingRow
            key={key}
            title={t(`gitRepo.extras.graphColumns.${labelKey}`)}
            control={
              <Switch
                checked={graphColumns[key]}
                onCheckedChange={(on) => setGraphColumn(key, on)}
                aria-label={t(`gitRepo.extras.graphColumns.${labelKey}`)}
              />
            }
          />
        ))}
        <SettingRow
          title={t("gitRepo.extras.graphColumns.tail")}
          description={t("gitRepo.extras.graphColumns.tailHint")}
          control={
            <Switch
              checked={graphTail}
              onCheckedChange={setGraphTail}
              aria-label={t("gitRepo.extras.graphColumns.tail")}
            />
          }
        />
      </div>
    </SettingCard>
  );
}

function DiffDefaultsCard() {
  const { t } = useAppTranslation();
  const diffView = useUi((state) => state.diffView);
  const diffLayout = useUi((state) => state.diffLayout);
  const wordDiff = useUi((state) => state.wordDiff);
  const ignoreWhitespace = useUi((state) => state.ignoreWhitespace);
  const fullFileDiff = useUi((state) => state.fullFileDiff);
  const wrapLines = useUi((state) => state.wrapLines);
  const setDiffView = useUi((state) => state.setDiffView);
  const setDiffLayout = useUi((state) => state.setDiffLayout);
  const setWordDiff = useUi((state) => state.setWordDiff);
  const setIgnoreWhitespace = useUi((state) => state.setIgnoreWhitespace);
  const setFullFileDiff = useUi((state) => state.setFullFileDiff);
  const setWrapLines = useUi((state) => state.setWrapLines);

  return (
    <SettingCard
      title={t("gitRepo.extras.diffDefaults.title")}
      description={t("gitRepo.extras.diffDefaults.description")}
    >
      <div className="divide-border flex flex-col divide-y">
        <SettingRow
          title={t("gitRepo.extras.diffDefaults.view")}
          control={
            <Select
              value={diffView}
              onValueChange={(value) => setDiffView(value as typeof diffView)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inline">
                  {t("gitRepo.extras.diffDefaults.viewInline")}
                </SelectItem>
                <SelectItem value="split">{t("gitRepo.extras.diffDefaults.viewSplit")}</SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          title={t("gitRepo.extras.diffDefaults.layout")}
          control={
            <Select
              value={diffLayout}
              onValueChange={(value) => setDiffLayout(value as typeof diffLayout)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="file">{t("gitRepo.extras.diffDefaults.layoutFile")}</SelectItem>
                <SelectItem value="all">{t("gitRepo.extras.diffDefaults.layoutAll")}</SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          title={t("gitRepo.extras.diffDefaults.wordDiff")}
          control={
            <Switch
              checked={wordDiff}
              onCheckedChange={setWordDiff}
              aria-label={t("gitRepo.extras.diffDefaults.wordDiff")}
            />
          }
        />
        <SettingRow
          title={t("gitRepo.extras.diffDefaults.ignoreWhitespace")}
          control={
            <Switch
              checked={ignoreWhitespace}
              onCheckedChange={setIgnoreWhitespace}
              aria-label={t("gitRepo.extras.diffDefaults.ignoreWhitespace")}
            />
          }
        />
        <SettingRow
          title={t("gitRepo.extras.diffDefaults.fullFile")}
          control={
            <Switch
              checked={fullFileDiff}
              onCheckedChange={setFullFileDiff}
              aria-label={t("gitRepo.extras.diffDefaults.fullFile")}
            />
          }
        />
        <SettingRow
          title={t("gitRepo.extras.diffDefaults.wrap")}
          control={
            <Switch
              checked={wrapLines}
              onCheckedChange={setWrapLines}
              aria-label={t("gitRepo.extras.diffDefaults.wrap")}
            />
          }
        />
      </div>
    </SettingCard>
  );
}

function AutoFetchCard() {
  const { t } = useAppTranslation();
  const autoFetchMinutes = useGitSettings((state) => state.autoFetchMinutes);
  const setAutoFetchMinutes = useGitSettings((state) => state.setAutoFetchMinutes);

  return (
    <SettingCard
      title={t("gitRepo.extras.autoFetch.title")}
      description={t("gitRepo.extras.autoFetch.description")}
      action={
        <Select
          value={String(autoFetchMinutes)}
          onValueChange={(value) => setAutoFetchMinutes(Number(value))}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">{t("gitRepo.extras.autoFetch.off")}</SelectItem>
            {[1, 5, 15].map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {t("gitRepo.extras.autoFetch.minutes", { count: minutes })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

function PullRequestsCard() {
  const { t } = useAppTranslation();
  const showPullRequests = useGitSettings((state) => state.showPullRequests);
  const setShowPullRequests = useGitSettings((state) => state.setShowPullRequests);

  return (
    <SettingCard
      title={t("gitRepo.extras.pullRequests.title")}
      description={t("gitRepo.extras.pullRequests.description")}
      action={
        <Switch
          checked={showPullRequests}
          onCheckedChange={setShowPullRequests}
          aria-label={t("gitRepo.extras.pullRequests.label")}
        />
      }
    />
  );
}

function CloneFolderCard() {
  const { t } = useAppTranslation();
  const cloneRoot = useRepositoryPrefs((state) => state.cloneRoot);
  const setCloneRoot = useRepositoryPrefs((state) => state.setCloneRoot);

  const choose = async () => {
    const picked = await pickDirectory({
      directory: true,
      title: t("gitRepo.extras.clone.chooseTitle"),
    });
    if (typeof picked === "string") setCloneRoot(picked);
  };

  return (
    <SettingCard
      title={t("gitRepo.extras.clone.title")}
      description={t("gitRepo.extras.clone.description")}
      action={
        <div className="flex items-center gap-2">
          {cloneRoot && (
            <Button variant="ghost" size="sm" onClick={() => setCloneRoot(null)}>
              {t("gitRepo.extras.clone.clear")}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => void choose()}>
            <FolderOpen className="size-3.5" />
            {t("gitRepo.extras.clone.choose")}
          </Button>
        </div>
      }
    >
      <p className="text-muted-foreground truncate font-mono text-xs">
        {cloneRoot ? shortenHome(cloneRoot) : t("gitRepo.extras.clone.none")}
      </p>
    </SettingCard>
  );
}

function EditorCard() {
  const { t } = useAppTranslation();
  const { editors, loading, rescan } = useEditors();
  const editorId = useGitSettings((state) => state.editorId);
  const setEditorId = useGitSettings((state) => state.setEditorId);

  return (
    <SettingCard
      title={t("gitRepo.extras.editor.title")}
      description={t("gitRepo.extras.editor.description")}
      action={
        <Button variant="ghost" size="sm" onClick={rescan} disabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          {t("gitRepo.extras.editor.rescan")}
        </Button>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : editors.length === 0 ? (
        <SettingEmpty
          icon={<Code2 className="size-4" />}
          title={t("gitRepo.extras.editor.empty")}
          description={t("gitRepo.extras.editor.emptyDesc")}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {editors.map((editor) => (
            <button
              key={editor.id}
              type="button"
              onClick={() => setEditorId(editor.id)}
              className={cn(
                "border-border flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                editorId === editor.id ? "bg-muted" : "hover:bg-muted/60"
              )}
            >
              <Code2 className="text-muted-foreground size-4" />
              <span className="min-w-0 flex-1 truncate">{editor.label}</span>
              {editorId === editor.id && <Badge>{t("gitRepo.extras.editor.inUse")}</Badge>}
            </button>
          ))}
        </div>
      )}
    </SettingCard>
  );
}

function CliAgentPicker() {
  const { t } = useAppTranslation();
  const cliAgent = useAi((state) => state.ai.cliAgent);
  const cliPath = useAi((state) => state.ai.cliPath);
  const setCliAgent = useAi((state) => state.setCliAgent);
  const setCliPath = useAi((state) => state.setCliPath);
  const { agents, loading, rescan } = useCliAgents();

  useEffect(() => {
    if (!agents) return;
    const found = agents.find((agent) => agent.id === useAi.getState().ai.cliAgent);
    if (found) {
      if (found.path !== useAi.getState().ai.cliPath) setCliPath(found.path);
      return;
    }
    const first = agents[0];
    if (!first) return;
    const id = knownAgentId(first.id);
    if (!id) return;
    setCliAgent(id);
    setCliPath(first.path);
  }, [agents, setCliAgent, setCliPath]);

  if (agents === null) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground/70 text-xs">{t("gitRepo.extras.ai.cli.title")}</span>
        <Button variant="ghost" size="sm" onClick={rescan} disabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          {t("gitRepo.extras.ai.cli.refresh")}
        </Button>
      </div>
      {agents.length === 0 ? (
        <SettingEmpty
          icon={<Terminal className="size-4" />}
          title={t("gitRepo.extras.ai.cli.empty")}
          description={t("gitRepo.extras.ai.cli.emptyDesc")}
        />
      ) : (
        agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => {
              const id = knownAgentId(agent.id);
              if (!id) return;
              setCliAgent(id);
              setCliPath(agent.path);
            }}
            className={cn(
              "border-border flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
              cliAgent === agent.id ? "bg-muted" : "hover:bg-muted/60"
            )}
          >
            <Terminal className="text-muted-foreground size-4" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{agent.label}</span>
              <span className="text-muted-foreground/70 block truncate font-mono text-xs">
                {shortenHome(agent.path)}
              </span>
            </span>
            {cliAgent === agent.id && <Badge>{t("gitRepo.extras.ai.cli.inUse")}</Badge>}
          </button>
        ))
      )}
      {cliPath && <p className="text-muted-foreground/70 text-xs">{shortenHome(cliPath)}</p>}
    </div>
  );
}

function ModelField() {
  const { t } = useAppTranslation();
  const ai = useAi((state) => state.ai);
  const setModel = useAi((state) => state.setModel);
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const preset = AI_PROVIDER_PRESETS[ai.provider];

  const load = async () => {
    if (preset.needsApiKey && !ai.apiKey) {
      toast.info(t("gitRepo.extras.ai.needKey"));
      return;
    }
    setLoading(true);
    try {
      const config: AiConfig = {
        provider: ai.provider,
        apiKey: ai.apiKey,
        model: ai.model,
        baseUrl: ai.baseUrl || undefined,
        cliAgent: ai.cliAgent || undefined,
        cliPath: ai.cliPath || undefined,
      };
      setModels(await listAiModels(config, (request) => httpRequest(request)));
    } catch (error) {
      toast.error((error as { message?: string }).message ?? String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Field
      label={t("gitRepo.extras.ai.model")}
      hint={t("gitRepo.extras.ai.modelHint", { model: preset.defaultModel })}
    >
      <div className="flex items-center gap-2">
        <Input
          value={ai.model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={preset.defaultModel}
          list="git-ai-models"
        />
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {t("gitRepo.extras.ai.loadModels")}
        </Button>
      </div>
      {models && (
        <datalist id="git-ai-models">
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      )}
    </Field>
  );
}

function CommitStyleCard() {
  const { t } = useAppTranslation();
  const commit = useGitSettings((state) => state.aiStyle.commit);
  const setCommitStyle = useGitSettings((state) => state.setCommitStyle);
  const branch = useRepo((state) => state.status?.branch ?? null);
  const prefix = resolveCommitPrefix(commit.prefixRules, branch);

  const updateRule = (index: number, patch: Partial<CommitPrefixRule>) =>
    setCommitStyle({
      prefixRules: commit.prefixRules.map((rule, i) =>
        i === index ? { ...rule, ...patch } : rule
      ),
    });
  const addRule = () =>
    setCommitStyle({ prefixRules: [...commit.prefixRules, { pattern: "", prefix: "" }] });
  const removeRule = (index: number) =>
    setCommitStyle({ prefixRules: commit.prefixRules.filter((_, i) => i !== index) });

  return (
    <SettingCard
      title={t("gitRepo.extras.commitStyle.title")}
      description={t("gitRepo.extras.commitStyle.description")}
    >
      <div className="flex flex-col gap-3">
        <Field label={t("gitRepo.extras.commitStyle.preset")}>
          <Select
            value={commit.preset}
            onValueChange={(value) => setCommitStyle({ preset: value as CommitStylePreset })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(COMMIT_STYLE_PRESETS) as CommitStylePreset[]).map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {t(COMMIT_STYLE_PRESETS[preset].labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground/70 text-xs">
            {t(COMMIT_STYLE_PRESETS[commit.preset].descriptionKey)}
          </span>
        </Field>
        <Field label={t("gitRepo.extras.commitStyle.language")}>
          <Select
            value={commit.language ?? "zh"}
            onValueChange={(value) => setCommitStyle({ language: value as CommitLanguage })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh">{t("gitRepo.extras.commitStyle.languageZh")}</SelectItem>
              <SelectItem value="en">{t("gitRepo.extras.commitStyle.languageEn")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {commit.preset === "custom" && (
          <Field label={t("gitRepo.extras.commitStyle.customLabel")}>
            <Textarea
              rows={3}
              value={commit.instructions}
              onChange={(event) => setCommitStyle({ instructions: event.target.value })}
              placeholder={t("gitRepo.extras.commitStyle.customPlaceholder")}
            />
          </Field>
        )}
        <div className="border-border bg-muted/40 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-xs font-medium">
              {t("gitRepo.extras.commitStyle.prefixRules")}
            </span>
            <Button variant="ghost" size="xs" onClick={addRule}>
              <Plus className="size-3" />
              {t("gitRepo.extras.commitStyle.addRule")}
            </Button>
          </div>
          <p className="text-muted-foreground/70 mt-1 text-xs">
            {t("gitRepo.extras.commitStyle.prefixRulesHint")}
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {commit.prefixRules.map((rule, index) => (
              <div key={index} className="grid grid-cols-[1fr_auto_1fr_28px] items-center gap-2">
                <Input
                  value={rule.pattern}
                  onChange={(event) => updateRule(index, { pattern: event.target.value })}
                  placeholder="feature/*"
                  className="h-8 font-mono text-xs"
                  aria-label={t("gitRepo.extras.commitStyle.pattern")}
                />
                <span className="text-muted-foreground/70">→</span>
                <Input
                  value={rule.prefix}
                  onChange={(event) => updateRule(index, { prefix: event.target.value })}
                  placeholder="{ticket}"
                  className="h-8 font-mono text-xs"
                  aria-label={t("gitRepo.extras.commitStyle.prefix")}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => removeRule(index)}
                  aria-label={t("gitRepo.extras.commitStyle.removeRule")}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground/70 mt-2 text-xs">
            {t("gitRepo.extras.commitStyle.tokens")}
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-muted-foreground/70">
              {t("gitRepo.extras.commitStyle.preview")}
            </span>
            <span className="font-mono">
              {prefix ? `${prefix} ` : ""}
              {t("gitRepo.extras.commitStyle.previewSample")}
            </span>
          </div>
        </div>
      </div>
    </SettingCard>
  );
}

function ReviewStyleCard() {
  const { t } = useAppTranslation();
  const review = useGitSettings((state) => state.aiStyle.review);
  const setReviewStyle = useGitSettings((state) => state.setReviewStyle);

  return (
    <SettingCard
      title={t("gitRepo.extras.reviewStyle.title")}
      description={t("gitRepo.extras.reviewStyle.description")}
    >
      <Field label={t("gitRepo.extras.reviewStyle.instructions")}>
        <Textarea
          rows={4}
          value={review.instructions}
          onChange={(event) => setReviewStyle({ instructions: event.target.value })}
          placeholder={t("gitRepo.extras.reviewStyle.placeholder")}
        />
      </Field>
      <p className="text-muted-foreground/70 mt-2 text-xs">
        {t("gitRepo.extras.reviewStyle.projectNote", { file: ".angkorgit/review.md" })}
      </p>
    </SettingCard>
  );
}

function RepoInstructionsCard() {
  const { t } = useAppTranslation();
  const repoPath = useRepo((state) => state.repo?.path ?? null);
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    setLoaded(false);
    if (!repoPath) {
      setValue("");
      return;
    }
    let cancelled = false;
    void recentRepositories()
      .then((list) => {
        if (cancelled) return;
        setValue(list.find((entry) => entry.path === repoPath)?.aiInstructions ?? "");
      })
      .catch(() => {
        if (!cancelled) setValue("");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    []
  );

  const scheduleSave = (next: string) => {
    if (!repoPath) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void recentSetAiInstructions(repoPath, next).catch(() => {
        toast.error(t("gitRepo.extras.repoInstructions.saveFailed"));
      });
    }, 400);
  };

  return (
    <SettingCard
      title={t("gitRepo.extras.repoInstructions.title")}
      description={t("gitRepo.extras.repoInstructions.description")}
    >
      {repoPath ? (
        <>
          <Field label={t("gitRepo.extras.repoInstructions.label")}>
            <Textarea
              rows={4}
              value={value}
              disabled={!loaded}
              onChange={(event) => {
                setValue(event.target.value);
                scheduleSave(event.target.value);
              }}
              placeholder={t("gitRepo.extras.repoInstructions.placeholder")}
            />
          </Field>
          <p className="text-muted-foreground/70 mt-2 text-xs">
            {t("gitRepo.extras.repoInstructions.hint")}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground/70 text-xs">
          {t("gitRepo.extras.repoInstructions.noRepo")}
        </p>
      )}
    </SettingCard>
  );
}

function AiProviderCard() {
  const { t } = useAppTranslation();
  const ai = useAi((state) => state.ai);
  const setProvider = useAi((state) => state.setProvider);
  const setModel = useAi((state) => state.setModel);
  const setBaseUrl = useAi((state) => state.setBaseUrl);
  const setApiKey = useAi((state) => state.setApiKey);
  const storedStatus = useGitSettings((state) => state.aiStatus);
  const aiStatusKey = useGitSettings((state) => state.aiStatusKey);
  const setAiStatus = useGitSettings((state) => state.setAiStatus);
  const [testing, setTesting] = useState(false);
  const preset = AI_PROVIDER_PRESETS[ai.provider];
  const aiStatus =
    storedStatus !== "untested" && aiStatusKey !== aiConfigSignature(ai) ? "stale" : storedStatus;

  const testAi = async () => {
    const tested = aiConfigSignature(ai);
    setTesting(true);
    try {
      const ok = await getAiProvider().ping();
      setAiStatus(ok ? "ok" : "fail", tested);
    } catch {
      setAiStatus("fail", tested);
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingCard
      title={t("gitRepo.extras.ai.provider.title")}
      description={
        ai.provider === "cli"
          ? t("gitRepo.extras.ai.provider.descriptionCli")
          : t("gitRepo.extras.ai.provider.descriptionApi")
      }
      action={
        <Select value={ai.provider} onValueChange={(value) => setProvider(value as AiProviderKind)}>
          <SelectTrigger className="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(AI_PROVIDER_PRESETS) as AiProviderKind[]).map((kind) => (
              <SelectItem key={kind} value={kind}>
                {AI_PROVIDER_PRESETS[kind].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <div className="flex flex-col gap-3">
        {ai.provider === "cli" ? (
          <>
            <CliAgentPicker />
            <Field
              label={t("gitRepo.extras.ai.modelOverride")}
              hint={t("gitRepo.extras.ai.modelOverrideHint")}
            >
              <Input
                value={ai.model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={t("gitRepo.extras.ai.modelOverridePlaceholder")}
              />
            </Field>
          </>
        ) : (
          <>
            {preset.needsApiKey && (
              <Field label={t("gitRepo.extras.ai.apiKey")}>
                <Input
                  type="password"
                  value={ai.apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-…"
                />
              </Field>
            )}
            <Field
              label={t("gitRepo.extras.ai.baseUrl")}
              hint={t("gitRepo.extras.ai.baseUrlHint", { url: preset.defaultBaseUrl })}
            >
              <Input
                value={ai.baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={preset.defaultBaseUrl}
              />
            </Field>
            <ModelField />
          </>
        )}
        <div className="border-border flex items-center justify-between gap-3 border-t pt-3">
          <span className="flex items-center gap-1.5 text-xs">
            {aiStatus === "ok" && (
              <>
                <span className="bg-primary size-1.5 rounded-full" />
                <span className="text-primary">{t("gitRepo.extras.ai.status.reachable")}</span>
              </>
            )}
            {aiStatus === "fail" && (
              <>
                <span className="bg-destructive size-1.5 rounded-full" />
                <span className="text-destructive">{t("gitRepo.extras.ai.status.fail")}</span>
              </>
            )}
            {aiStatus === "untested" && (
              <span className="text-muted-foreground/70">
                {t("gitRepo.extras.ai.status.untested")}
              </span>
            )}
            {aiStatus === "stale" && (
              <span className="text-muted-foreground/70">
                {t("gitRepo.extras.ai.status.stale")}
              </span>
            )}
          </span>
          <Button variant="secondary" size="sm" onClick={() => void testAi()} disabled={testing}>
            {testing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Wifi className="size-3.5" />
            )}
            {t("gitRepo.extras.ai.test")}
          </Button>
        </div>
      </div>
    </SettingCard>
  );
}

export function GitSettingsPanel() {
  const { t } = useAppTranslation();
  const open = useUi((state) => state.dialog === "settings");
  const dialogContext = useUi((state) => state.dialogContext);
  const closeDialog = useUi((state) => state.closeDialog);
  const section = useGitSettings((state) => state.settingsSection);
  const setSection = useGitSettings((state) => state.setSettingsSection);

  useEffect(() => {
    if (!open) return;
    if (dialogContext && typeof dialogContext === "object" && "section" in dialogContext) {
      const next = (dialogContext as SettingsPreset).section;
      setSection(next === "shortcuts" ? "appearance" : next);
    }
  }, [open, dialogContext, setSection]);

  return (
    <Dialog open={open} onOpenChange={(value) => !value && closeDialog()}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">{t("gitRepo.extras.settings.title")}</DialogTitle>
        {/* The dialog draws its own header, so the label Radix wants is only for
            assistive tech; without it Radix logs a missing-Description warning. */}
        <DialogDescription className="sr-only">
          {t(`gitRepo.extras.settings.sectionDesc.${section}`)}
        </DialogDescription>
        <div className="flex h-[560px] max-h-[80vh]">
          <nav className="border-border bg-card flex w-52 shrink-0 flex-col gap-1 border-r p-3">
            <span className="text-muted-foreground px-3 pb-2 text-xs font-medium">
              {t("gitRepo.extras.settings.title")}
            </span>
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  section === item.id
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/60"
                )}
              >
                {item.icon}
                {t(item.labelKey)}
              </button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="border-border shrink-0 border-b px-6 py-4">
              <h2 className="text-sm font-medium">
                {t(`gitRepo.extras.settings.sections.${section}`)}
              </h2>
              <p className="text-muted-foreground/70 mt-0.5 text-xs">
                {t(`gitRepo.extras.settings.sectionDesc.${section}`)}
              </p>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              {section === "appearance" && (
                <div className="flex flex-col gap-4">
                  <GraphColumnsCard />
                  <DiffDefaultsCard />
                  <FontsCard />
                </div>
              )}
              {section === "git" && (
                <div className="flex flex-col gap-4">
                  <AutoFetchCard />
                  <PullRequestsCard />
                  <CloneFolderCard />
                  <EditorCard />
                  <IdentityPanel />
                </div>
              )}
              {section === "accounts" && (
                <div className="flex flex-col gap-4">
                  <AccountsPanel />
                </div>
              )}
              {section === "ai" && (
                <div className="flex flex-col gap-4">
                  <AiProviderCard />
                  <CommitStyleCard />
                  <RepoInstructionsCard />
                  <ReviewStyleCard />
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

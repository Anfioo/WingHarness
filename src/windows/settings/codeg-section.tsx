import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Play, RotateCw, Square } from "lucide-react";
import { toast } from "sonner";
import {
  codegRestart,
  codegStart,
  codegState,
  codegStop,
  CODEG_STATUS_EVENT,
  type CodegConfig,
  type CodegServerStatus,
  type CodegView,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useConfigDraft } from "@/hooks/use-config-draft";
import { cn } from "@/lib/utils";

/**
 * The Codeg partition of the Settings window.
 *
 * Two halves: where Codeg lives (a draft of `config.codeg`, saved the way every
 * other section saves), and the server process itself, which this app owns and
 * starts for the user. A path or port change only reaches the server on the next
 * start, so the restart button sits right there.
 */
export function CodegSection() {
  const { t } = useAppTranslation();
  const { draft, setDraft, loading } = useConfigDraft("codeg config");

  const [server, setServer] = useState<CodegView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Kept as text so the field can be half-typed; only a valid number reaches the
  // draft, which is what makes the port survive an auto-save.
  const [portText, setPortText] = useState("");

  const refresh = useCallback(() => {
    codegState()
      .then((next) => {
        setServer(next);
        setPortText(String(next.settings.port));
      })
      .catch((error: unknown) => {
        console.error("Failed to read the Codeg state:", error);
        setFailure(String(error));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The page starts the server too, and a crash moves it with no button pressed
  // here: the status follows the backend rather than this window's own actions.
  useEffect(() => {
    const unlisten = listen<CodegServerStatus>(CODEG_STATUS_EVENT, (event) => {
      const next = event.payload;
      setServer((current) => (current ? { ...current, server: next } : current));
      if (next.status === "failed") setFailure(next.message);
      else if (next.status === "ready") setFailure(null);
    });

    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  /** Runs one server action, reporting why when it fails. */
  const act = useCallback(
    async (run: () => Promise<CodegServerStatus>) => {
      setBusy(true);
      setFailure(null);
      try {
        const next = await run();
        setServer((current) => (current ? { ...current, server: next } : current));
        if (next.status === "failed") setFailure(next.message);
        // The server's own output is what explains a refusal, so re-read it.
        refresh();
      } catch (error) {
        console.error("Failed to run a Codeg server action:", error);
        setFailure(String(error));
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const update = useCallback(
    (patch: Partial<CodegConfig>) => {
      if (!draft) return;
      setDraft({ ...draft, codeg: { ...draft.codeg, ...patch } });
    },
    [draft, setDraft]
  );

  if (loading || !draft) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold">{t("codeg.settings.title")}</h2>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const status = server?.server ?? { status: "stopped" as const };
  const running = status.status === "ready" || status.status === "starting";
  const message = failure ?? (status.status === "failed" ? status.message : null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("codeg.settings.title")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t("codeg.settings.description")}</p>
      </div>

      {/* Server: state, controls, and why when it failed. */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold">{t("codeg.settings.server")}</h3>
            <p className="text-muted-foreground text-xs">{t("codeg.settings.serverHint")}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || running}
              onClick={() => void act(codegStart)}
            >
              <Play />
              {t("codeg.settings.start")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !running}
              onClick={() => void act(codegStop)}
            >
              <Square />
              {t("codeg.settings.stop")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void act(codegRestart)}
            >
              <RotateCw className={cn(busy && "animate-spin")} />
              {t("codeg.settings.restart")}
            </Button>
          </div>
        </div>

        <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3 text-sm">
          <span
            className={cn(
              "size-2 rounded-full",
              status.status === "ready"
                ? "bg-emerald-500"
                : status.status === "failed"
                  ? "bg-destructive"
                  : status.status === "starting"
                    ? "bg-amber-500"
                    : "bg-muted-foreground/40"
            )}
          />
          <span className="font-medium">
            {status.status === "ready"
              ? t("codeg.settings.ready")
              : status.status === "starting"
                ? t("codeg.settings.starting")
                : status.status === "failed"
                  ? t("codeg.settings.failed")
                  : t("codeg.settings.stopped")}
          </span>
          {status.status === "ready" && (
            <span className="text-muted-foreground font-mono text-xs">{status.url}</span>
          )}
          {message && (
            <p className="text-destructive w-full font-mono text-[11px] whitespace-pre-wrap">
              {message}
            </p>
          )}
        </div>
      </section>

      {/* Where Codeg lives. */}
      <section className="space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold">{t("codeg.settings.paths")}</h3>
          <p className="text-muted-foreground text-xs">{t("codeg.settings.pathsHint")}</p>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium">{t("codeg.settings.repoPath")}</span>
          <Input
            className="font-mono text-xs"
            value={draft.codeg.repoPath}
            onChange={(event) => update({ repoPath: event.target.value })}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium">{t("codeg.settings.staticDir")}</span>
          <Input
            className="font-mono text-xs"
            value={draft.codeg.staticDir}
            onChange={(event) => update({ staticDir: event.target.value })}
          />
          <span className="text-muted-foreground block text-[11px]">
            {t("codeg.settings.staticDirHint")}
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium">{t("codeg.settings.serverPath")}</span>
          <Input
            className="font-mono text-xs"
            value={draft.codeg.serverPath}
            onChange={(event) => update({ serverPath: event.target.value })}
          />
          <span className="text-muted-foreground block text-[11px]">
            {t("codeg.settings.serverPathHint")}
          </span>
        </label>

        <div className="flex gap-3">
          <label className="block w-32 space-y-1">
            <span className="text-xs font-medium">{t("codeg.settings.port")}</span>
            <Input
              inputMode="numeric"
              className="font-mono text-xs"
              value={portText}
              onChange={(event) => {
                const next = event.target.value;
                setPortText(next);
                const parsed = Number.parseInt(next, 10);
                if (/^\d+$/.test(next) && parsed > 0 && parsed <= 65_535) update({ port: parsed });
              }}
            />
          </label>
          <label className="block flex-1 space-y-1">
            <span className="text-xs font-medium">{t("codeg.settings.dataDir")}</span>
            <Input
              className="font-mono text-xs"
              value={draft.codeg.dataDir}
              placeholder={server?.settings.dataDir ?? ""}
              onChange={(event) => update({ dataDir: event.target.value })}
            />
            <span className="text-muted-foreground block text-[11px]">
              {t("codeg.settings.dataDirHint")}
            </span>
          </label>
        </div>

        <p className="text-muted-foreground text-[11px]">{t("codeg.settings.restartHint")}</p>
      </section>

      {/* Token and output: what the page is authenticated with, and what the
          server said last. */}
      <section className="space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold">{t("codeg.settings.token")}</h3>
          <p className="text-muted-foreground text-xs">{t("codeg.settings.tokenHint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            className="font-mono text-xs"
            value={server?.token ?? ""}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!server?.token}
            onClick={() => {
              if (!server) return;
              void navigator.clipboard
                .writeText(server.token)
                .then(() => toast.success(t("codeg.settings.tokenCopied")))
                .catch((error: unknown) => toast.error(String(error)));
            }}
          >
            {t("codeg.settings.copy")}
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("codeg.settings.log")}</h3>
        <pre className="bg-muted text-muted-foreground max-h-56 overflow-auto rounded-lg p-3 font-mono text-[11px] whitespace-pre-wrap">
          {server && server.log.length > 0 ? server.log.join("\n") : t("codeg.settings.logEmpty")}
        </pre>
      </section>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  argusErrorKey,
  argusStartupList,
  argusStartupSetEnabled,
  type StartupItem,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";

export function useTaskManagerStartup() {
  const { t } = useAppTranslation();
  const [items, setItems] = useState<StartupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await argusStartupList();
      if (!mounted.current) return;
      setItems(next);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const setEnabled = useCallback(
    async (item: StartupItem, enabled: boolean) => {
      if (item.blocked || pending.has(item.id)) return;
      setPending((current) => new Set(current).add(item.id));
      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, enabled } : entry))
      );
      try {
        await argusStartupSetEnabled(item.id, enabled);
        toast.success(
          t(enabled ? "taskManager.startup.toast.enabled" : "taskManager.startup.toast.disabled", {
            name: item.name,
          })
        );
        await load();
      } catch (cause) {
        toast.error(t("taskManager.startup.toast.failed", { name: item.name }));
        if (typeof cause === "object" && cause !== null && "code" in cause) {
          const code = (cause as { code: Parameters<typeof argusErrorKey>[0] }).code;
          toast.error(t(argusErrorKey(code)));
        }
        await load();
      } finally {
        if (mounted.current) {
          setPending((current) => {
            const next = new Set(current);
            next.delete(item.id);
            return next;
          });
        }
      }
    },
    [load, pending, t]
  );

  return { items, loading, error, pending, load, setEnabled };
}

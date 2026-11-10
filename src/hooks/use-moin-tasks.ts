import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { moinListDownloads, type MoinTask, type MoinTaskProgress } from "@/commands";

export type MoinTaskMap = Record<string, MoinTask>;

export function useMoinTasks() {
  const [byId, setById] = useState<MoinTaskMap>({});
  const [progress, setProgress] = useState<Record<string, MoinTaskProgress>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const tasks = await moinListDownloads();
      setById(Object.fromEntries(tasks.map((task) => [task.id, task])));
      setError(null);
    } catch {
      setError("load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn[] = [];
    const listeners: UnlistenFn[] = [];

    const subscribe = async () => {
      try {
        listeners.push(
          await listen<MoinTask>("moin:task-added", ({ payload }) => {
            setById((current) => ({ ...current, [payload.id]: payload }));
          })
        );
        listeners.push(
          await listen<MoinTask>("moin:task-updated", ({ payload }) => {
            setById((current) => ({ ...current, [payload.id]: payload }));
          })
        );
        listeners.push(
          await listen<string>("moin:task-removed", ({ payload: id }) => {
            setById((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
            setProgress((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
          })
        );
        listeners.push(
          await listen<MoinTaskProgress[]>("moin:task-progress", ({ payload }) => {
            setProgress((current) => {
              const next = { ...current };
              for (const item of payload) {
                next[item.id] = { ...next[item.id], ...item };
              }
              return next;
            });
          })
        );
        listeners.push(
          await listen<MoinTask>("moin:task-completed", ({ payload }) => {
            setById((current) => ({ ...current, [payload.id]: payload }));
            setProgress((current) => {
              const next = { ...current };
              delete next[payload.id];
              return next;
            });
          })
        );
      } catch {
        listeners.splice(0).forEach((dispose) => dispose());
      }

      if (cancelled) {
        listeners.forEach((dispose) => dispose());
        return;
      }
      unlisten = listeners;
      void reload();
    };

    void subscribe();

    return () => {
      cancelled = true;
      unlisten.forEach((dispose) => dispose());
    };
  }, [reload]);

  const tasks = useMemo(
    () => Object.values(byId).sort((left, right) => right.created_at - left.created_at),
    [byId]
  );

  return { tasks, byId, progress, loading, error, reload };
}

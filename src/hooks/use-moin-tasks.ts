import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isMoinError,
  moinErrorKey,
  moinListDownloads,
  type MoinTask,
  type MoinTaskProgress,
} from "@/commands";

export type MoinTaskMap = Record<string, MoinTask>;

/**
 * Snapshot + live events for the download list.
 *
 * `error` holds an i18n key (`moin.error.*`), not a sentence: the backend only
 * sends an English `message`, and every visible string in this feature is
 * translated by the page.
 */
export function useMoinTasks(): {
  tasks: MoinTask[];
  byId: MoinTaskMap;
  progress: Record<string, MoinTaskProgress>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [byId, setById] = useState<MoinTaskMap>({});
  const [progress, setProgress] = useState<Record<string, MoinTaskProgress>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const tasks = await moinListDownloads();
      if (!mounted.current) return;
      setById(Object.fromEntries(tasks.map((task) => [task.id, task])));
      setError(null);
    } catch (failure) {
      if (!mounted.current) return;
      setError(isMoinError(failure) ? moinErrorKey(failure.code) : moinErrorKey(undefined));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const listeners: UnlistenFn[] = [];
    let disposed = false;

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
                next[item.id] = item;
              }
              return next;
            });
          })
        );
        // The completion event carries the task, but `completed_at` and the
        // final file size are written by the engine just after it fires, so one
        // snapshot keeps the row honest.
        listeners.push(
          await listen<MoinTask>("moin:task-completed", ({ payload }) => {
            setById((current) => ({ ...current, [payload.id]: payload }));
            setProgress((current) => {
              const next = { ...current };
              delete next[payload.id];
              return next;
            });
            void reload();
          })
        );
      } catch {
        listeners.splice(0).forEach((dispose) => dispose());
      }

      if (disposed) {
        listeners.forEach((dispose) => dispose());
        return;
      }
      void reload();
    };

    void subscribe();

    return () => {
      disposed = true;
      mounted.current = false;
      listeners.forEach((dispose) => dispose());
    };
  }, [reload]);

  const tasks = useMemo(
    () => Object.values(byId).sort((left, right) => right.created_at - left.created_at),
    [byId]
  );

  return { tasks, byId, progress, loading, error, reload };
}

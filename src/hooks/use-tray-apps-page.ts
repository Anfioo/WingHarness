import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { trayAppsList, trayAppsSave, type TrayApp, type TrayAppsView } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** The apps split the way the tray menu draws them, plus the hidden ones. */
export type CuratedApps = {
  /** Shown first, in menu order. */
  pinned: TrayApp[];
  /** Shown after the pinned ones, in menu order. */
  rest: TrayApp[];
  /** Kept back for the list only; the tray never draws these. */
  hidden: TrayApp[];
};

export type TrayAppsPageController = {
  /** `null` until the first read lands. */
  view: TrayAppsView | null;
  loading: boolean;
  /** The last failure, already translated for display. */
  error: string | null;
  query: string;
  setQuery: (value: string) => void;
  /** The list the page draws, filtered by `query`. */
  filtered: TrayApp[];
  curated: CuratedApps;
  counts: { total: number; showing: number; pinned: number; hidden: number };
  refresh: () => Promise<void>;
  togglePin: (app: TrayApp) => void;
  toggleHide: (app: TrayApp) => void;
  /** Moves `appId` before `beforeId`, or to the end when it is `null`. */
  move: (appId: string, beforeId: string | null) => void;
  reset: () => void;
};

const lower = (id: string) => id.toLowerCase();

/**
 * The same ordering the backend applies when it reads the list: pinned first,
 * then the dragged order, then anything the user never placed, alphabetically.
 * Drawing the optimistic result with the same rules means a toggle never shows
 * a row where the next open of the tray would not.
 */
function sortApps(apps: TrayApp[], pinnedIds: string[], order: string[]): TrayApp[] {
  const pinned = new Set(pinnedIds.map(lower));
  const rank = new Map(order.map((id, index) => [lower(id), index]));

  return [...apps].sort((left, right) => {
    const leftPinned = pinned.has(lower(left.id));
    const rightPinned = pinned.has(lower(right.id));
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

    const leftRank = rank.get(lower(left.id)) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(lower(right.id)) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;

    const leftName = lower(left.displayName);
    const rightName = lower(right.displayName);
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;

    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * The saved order with every app currently on disk appended if it was missing.
 * Unknown ids (an uninstalled app) stay in the list, so a reinstall returns to
 * its old place, and a newly installed app is still addressable by a drag.
 */
function orderWithVisibleIds(view: TrayAppsView): string[] {
  const order = view.order.length > 0 ? [...view.order] : [];
  const seen = new Set(order.map(lower));
  for (const app of view.apps) {
    const id = lower(app.id);
    if (!seen.has(id)) {
      order.push(app.id);
      seen.add(id);
    }
  }
  return order;
}

/**
 * State behind the tray menu's settings tab.
 *
 * Pin, hide and the dragged order are the three lists the tray reads when its
 * popup opens, so every change is written straight through — there is nothing
 * to apply afterwards. The page draws the change at once and saves in the
 * background; a save that fails puts the previous lists back, so what is on
 * screen is what the tray would show.
 */
export function useTrayAppsPage(): TrayAppsPageController {
  const { t } = useAppTranslation();
  const [view, setView] = useState<TrayAppsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setView(await trayAppsList());
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    (pinned: string[], hidden: string[], order: string[], previous: TrayAppsView) => {
      setView({ ...previous, pinned, hidden, order, apps: sortApps(previous.apps, pinned, order) });
      void trayAppsSave(pinned, hidden, order)
        .then(() => setError(null))
        .catch((cause: unknown) => {
          setView(previous);
          setError(String(cause));
          toast.error(t("trayApps.saveFailed"));
        });
    },
    [t]
  );

  const togglePin = useCallback(
    (app: TrayApp) => {
      if (!view) return;
      const isPinned = view.pinned.some((id) => lower(id) === lower(app.id));

      if (isPinned) {
        save(
          view.pinned.filter((id) => lower(id) !== lower(app.id)),
          view.hidden,
          view.order,
          view
        );
        return;
      }

      // Pinning is a "put it at the top" action, so the app also moves to the
      // front of the order; unpinning leaves its place to the next drag.
      const order = orderWithVisibleIds(view).filter((id) => lower(id) !== lower(app.id));
      save([...view.pinned, app.id], view.hidden, [app.id, ...order], view);
    },
    [save, view]
  );

  const toggleHide = useCallback(
    (app: TrayApp) => {
      if (!view) return;
      const hidden = view.hidden.some((id) => lower(id) === lower(app.id))
        ? view.hidden.filter((id) => lower(id) !== lower(app.id))
        : [...view.hidden, app.id];
      save(view.pinned, hidden, view.order, view);
    },
    [save, view]
  );

  const move = useCallback(
    (appId: string, beforeId: string | null) => {
      if (!view || beforeId === appId) return;

      const order = orderWithVisibleIds(view).filter((id) => lower(id) !== lower(appId));
      const target = beforeId ? order.findIndex((id) => lower(id) === lower(beforeId)) : -1;
      if (beforeId && target < 0) return;

      if (target >= 0) order.splice(target, 0, appId);
      else order.push(appId);

      // The row a drag lands on decides the section: dropping across the divider
      // pins or unpins the dragged app, which is what that divider means.
      const pinned = view.pinned.filter((id) => lower(id) !== lower(appId));
      if (beforeId && view.pinned.some((id) => lower(id) === lower(beforeId))) {
        pinned.push(appId);
      }

      save(pinned, view.hidden, order, view);
    },
    [save, view]
  );

  const reset = useCallback(() => {
    if (!view) return;
    save([], [], [], view);
  }, [save, view]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await load();
  }, [load]);

  const curated = useMemo<CuratedApps>(() => {
    const pinned = new Set(view?.pinned ?? []);
    const hidden = new Set(view?.hidden ?? []);
    const apps = view?.apps ?? [];
    return {
      pinned: apps.filter((app) => pinned.has(app.id) && !hidden.has(app.id)),
      rest: apps.filter((app) => !pinned.has(app.id) && !hidden.has(app.id)),
      hidden: apps.filter((app) => hidden.has(app.id)),
    };
  }, [view]);

  const filtered = useMemo(() => {
    const apps = view?.apps ?? [];
    const needle = query.trim().toLowerCase();
    return needle ? apps.filter((app) => app.displayName.toLowerCase().includes(needle)) : apps;
  }, [query, view]);

  const counts = useMemo(
    () => ({
      total: view?.apps.length ?? 0,
      showing: curated.pinned.length + curated.rest.length,
      pinned: curated.pinned.length,
      hidden: curated.hidden.length,
    }),
    [curated, view]
  );

  return {
    view,
    loading,
    error,
    query,
    setQuery,
    filtered,
    curated,
    counts,
    refresh,
    togglePin,
    toggleHide,
    move,
    reset,
  };
}

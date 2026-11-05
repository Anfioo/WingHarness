import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Server, X } from "lucide-react";
import { serverConnectionClose, serverProfilesList } from "@/commands/services/servers";
import type { ConnectionState, ServerProfile } from "@/commands/services/servers/types";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { errorText } from "@/lib/servers/format";
import { SERVER_OPEN_PROFILE_EVENT, type ServerOpenProfilePayload } from "@/lib/servers/windows";
import { cn } from "@/lib/utils";
import { ServerTab } from "./server-tab";

const STATE_DOT: Record<ConnectionState, string> = {
  idle: "bg-muted-foreground/50",
  connecting: "bg-amber-500 animate-pulse",
  ready: "bg-emerald-500",
  failed: "bg-destructive",
};

/**
 * The one server manager window: a tab per open server, each holding its own
 * terminal / XFTP view.
 *
 * Opening the same profile again only focuses its tab (one connection, one set
 * of panes). Closing a tab closes that profile's connection; closing the window
 * closes every open profile's connection before the window is destroyed.
 */
export default function ServerWindow() {
  const { t } = useAppTranslation();

  const [profiles, setProfiles] = useState<Record<string, ServerProfile>>({});
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, ConnectionState>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const openIdsRef = useRef<string[]>([]);
  useEffect(() => {
    openIdsRef.current = openIds;
  }, [openIds]);

  const bootedRef = useRef(false);
  const closingRef = useRef(false);

  const loadProfiles = useCallback(async () => {
    try {
      const view = await serverProfilesList();
      setProfiles(Object.fromEntries(view.profiles.map((profile) => [profile.id, profile])));
      setLoadError(null);
    } catch (failure) {
      setLoadError(errorText(failure));
    }
  }, []);

  const openProfile = useCallback((profileId: string) => {
    if (!profileId) return;
    setOpenIds((prev) => (prev.includes(profileId) ? prev : [...prev, profileId]));
    setActiveId(profileId);
  }, []);

  // First mount: the window may have been created with `?profile=`, which is
  // the only way the very first tab can arrive before the listener below.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void loadProfiles();
    const initial = new URLSearchParams(window.location.search).get("profile");
    if (initial) openProfile(initial);
  }, [loadProfiles, openProfile]);

  // An already-open window is told to add or focus a profile through this event.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<ServerOpenProfilePayload>(SERVER_OPEN_PROFILE_EVENT, (event) => {
      const profileId = event.payload?.profileId;
      if (typeof profileId !== "string" || !profileId) return;
      openProfile(profileId);
      // The list may have gained the profile (or a rename) since last load.
      void loadProfiles();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadProfiles, openProfile]);

  const closeProfile = useCallback((profileId: string) => {
    setOpenIds((prev) => prev.filter((id) => id !== profileId));
    setActiveId((current) => {
      if (current !== profileId) return current;
      const order = openIdsRef.current;
      const index = order.indexOf(profileId);
      const next = order.filter((id) => id !== profileId);
      return next[Math.min(index, next.length - 1)] ?? null;
    });
    setStates((prev) => {
      if (!(profileId in prev)) return prev;
      const next = { ...prev };
      delete next[profileId];
      return next;
    });
    void serverConnectionClose(profileId).catch(() => {});
  }, []);

  const handleState = useCallback((profileId: string, state: ConnectionState) => {
    setStates((prev) => (prev[profileId] === state ? prev : { ...prev, [profileId]: state }));
  }, []);

  // Closing the window must not leave connections (and their shell channels)
  // behind. The backend closes everything on app exit as well, but the window
  // can be closed long before the app is.
  useEffect(() => {
    const appWindow = getCurrentWebviewWindow();
    let unlisten: UnlistenFn | undefined;

    void appWindow
      .onCloseRequested(async (event) => {
        if (closingRef.current) return;
        closingRef.current = true;
        event.preventDefault();
        await Promise.allSettled(
          openIdsRef.current.map((profileId) => serverConnectionClose(profileId))
        );
        await appWindow.destroy();
      })
      .then((fn) => {
        unlisten = fn;
      });

    const flush = () => {
      openIdsRef.current.forEach((profileId) => {
        void serverConnectionClose(profileId).catch(() => {});
      });
    };
    window.addEventListener("beforeunload", flush);

    return () => {
      unlisten?.();
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  return (
    <WindowFrame
      titleBar={<TitleBar title={t("servers.window.title")} showPin />}
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {openIds.length > 0 && (
          <div className="border-border bg-card flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-2">
            {openIds.map((profileId) => {
              const state = states[profileId] ?? "idle";
              return (
                <div
                  key={profileId}
                  className={cn(
                    "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2.5 text-xs",
                    profileId === activeId
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                  onClick={() => setActiveId(profileId)}
                >
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])}
                    title={t(`servers.connection.${state}`)}
                  />
                  <span className="max-w-40 truncate">
                    {profiles[profileId]?.name ?? profileId}
                  </span>
                  <button
                    type="button"
                    className="hover:bg-foreground/10 rounded p-0.5 opacity-0 group-hover:opacity-100"
                    aria-label={t("servers.window.closeTab", { defaultValue: "Close tab" })}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeProfile(profileId);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {openIds.length === 0 ? (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm">
            <Server className="size-8" />
            <p className="text-foreground font-medium">{t("servers.window.empty.title")}</p>
            <p className="max-w-md">{t("servers.window.empty.description")}</p>
          </div>
        ) : (
          <div className="relative min-h-0 flex-1">
            {openIds.map((profileId) => {
              const profile = profiles[profileId];
              return (
                <div
                  key={profileId}
                  className={cn("absolute inset-0", profileId !== activeId && "hidden")}
                >
                  {profile ? (
                    <ServerTab
                      profile={profile}
                      active={profileId === activeId}
                      onStateChange={handleState}
                    />
                  ) : (
                    <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
                      {loadError ??
                        t("servers.window.loading", { defaultValue: "Loading server…" })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </WindowFrame>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TerminalTab } from "./TerminalTab";
import { loadTerminalPrefs, type TerminalPrefs } from "./prefs";

type Tab = { id: string; title: string };

let nextTabSeq = 1;
function newTabId() {
  return `tab-${Date.now()}-${nextTabSeq++}`;
}

export default function LocalTerminalPage() {
  const [tabs, setTabs] = useState<Tab[]>(() => [{ id: newTabId(), title: "终端 1" }]);
  const [activeTabId, setActiveTabId] = useState<string | null>(tabs[0]?.id ?? null);
  const [prefs, setPrefs] = useState<TerminalPrefs>(() => loadTerminalPrefs());

  // Settings are edited in the global settings window; sync back when they change.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "local-terminal-prefs") {
        setPrefs(loadTerminalPrefs());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((current) => {
        if (current !== id) return current;
        const idx = prev.findIndex((t) => t.id === id);
        return next[Math.min(idx, next.length - 1)]?.id ?? null;
      });
      return next;
    });
  }, []);

  const addTab = useCallback(() => {
    const tab: Tab = { id: newTabId(), title: `终端 ${nextTabSeq}` };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  return (
    <AppShell>
      <section className="border-border bg-card flex h-full min-h-[60vh] flex-1 flex-col overflow-hidden rounded-md border">
        {/* Tab bar */}
        <div className="border-border bg-card flex h-9 shrink-0 items-center gap-1 border-b px-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2.5 text-xs",
                  tab.id === activeTabId
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span className="max-w-24 truncate">{tab.title}</span>
                <button
                  type="button"
                  className="hover:bg-foreground/10 rounded p-0.5 opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}

            {tabs.length === 0 ? (
              <span className="text-muted-foreground px-2 text-xs">没有打开的终端</span>
            ) : null}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:bg-accent size-7"
            onClick={addTab}
            title="新建终端页签"
          >
            <Plus className="size-4" />
          </Button>
        </div>

        {/* Terminal panes: all mounted, hidden except active (xterm can't survive re-mount). */}
        <div className="relative min-h-0 flex-1">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn("absolute inset-0", tab.id !== activeTabId && "hidden")}
            >
              <TerminalTab sessionId={tab.id} active={tab.id === activeTabId} prefs={prefs} />
            </div>
          ))}

          {tabs.length === 0 ? (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3">
              <p className="text-sm">没有打开的终端页签</p>
              <Button variant="secondary" size="sm" onClick={addTab}>
                <Plus className="size-4" /> 打开本地终端
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </AppShell>
  );
}

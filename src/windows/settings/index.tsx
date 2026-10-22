import { useCallback, useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils.ts";
import { TitleBar } from "@/components/title-bar.tsx";
import { WindowFrame } from "@/components/window-frame.tsx";
import { ShortcutInput } from "@/components/shortcut-input.tsx";
import { AppearanceSection } from "./appearance-section.tsx";
import { ProjectSection } from "./project-section.tsx";
import { TerminalSection } from "./terminal-section.tsx";
import { DataSection } from "./data-section.tsx";
import { EditorSection } from "./editor-section.tsx";
import { Palette, Keyboard, FolderKanban, SquareTerminal, Database, SquarePen } from "lucide-react";
import { registerShortcut, unregisterShortcut } from "@/lib/shortcut.ts";
import { toggleWindow } from "@/lib/window.ts";
import { toast } from "sonner";
import { useAppTranslation } from "@/hooks/use-app-translation.ts";

const SHORTCUT_KEY = "global-shortcut-show-main";

type SettingSection = "appearance" | "shortcut" | "project" | "terminal" | "data" | "editor";

export default function SettingsPage() {
  const [shortcut, setShortcut] = useState<string>("");
  const [activeSection, setActiveSection] = useState<SettingSection>("appearance");
  const { t } = useAppTranslation();

  const handleShowMainWindow = useCallback(async () => {
    await toggleWindow("main");
  }, []);

  useEffect(() => {
    // Load saved shortcut
    const savedShortcut = localStorage.getItem(SHORTCUT_KEY);
    if (savedShortcut) {
      setShortcut(savedShortcut);
      registerShortcut(savedShortcut, handleShowMainWindow);
    }
  }, [handleShowMainWindow]);

  const handleShortcutChange = async (newShortcut: string) => {
    const oldShortcut = shortcut;
    setShortcut(newShortcut);

    if (newShortcut) {
      localStorage.setItem(SHORTCUT_KEY, newShortcut);
      await registerShortcut(newShortcut, handleShowMainWindow, oldShortcut);
      // Notify main window to update shortcut
      await emit("shortcut-changed", { shortcut: newShortcut });
      toast.success(t("settings.shortcut.setSuccess", { shortcut: newShortcut }));
    } else {
      localStorage.removeItem(SHORTCUT_KEY);
      if (oldShortcut) {
        await unregisterShortcut(oldShortcut);
      }
      // Notify main window to clear shortcut
      await emit("shortcut-changed", { shortcut: "" });
      toast.info(t("settings.shortcut.cleared"));
    }
  };

  const menuItems = [
    {
      id: "appearance" as SettingSection,
      label: t("settings.appearance.title"),
      icon: Palette,
    },
    {
      id: "shortcut" as SettingSection,
      label: t("settings.shortcut.title"),
      icon: Keyboard,
    },
    {
      id: "project" as SettingSection,
      label: t("project.title"),
      icon: FolderKanban,
    },
    {
      id: "terminal" as SettingSection,
      label: "终端",
      icon: SquareTerminal,
    },
    {
      id: "data" as SettingSection,
      label: t("data.title"),
      icon: Database,
    },
    {
      id: "editor" as SettingSection,
      label: t("editor.title"),
      icon: SquarePen,
    },
  ];

  return (
    <WindowFrame
      titleBar={<TitleBar title={t("settings.title")} showPin showMaximize={false} />}
      contentClassName="flex flex-1 overflow-hidden"
    >
      <aside className="border-border flex w-40 flex-col border-r p-4">
        <nav className="flex-1 space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  activeSection === item.id
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl p-4">
          {activeSection === "appearance" && <AppearanceSection />}

          {activeSection === "shortcut" && (
            <div className="space-y-4">
              <div>
                <h2 className="mb-1 text-lg font-semibold">{t("settings.shortcut.title")}</h2>
                <p className="text-muted-foreground text-sm">
                  {t("settings.shortcut.description")}
                </p>
              </div>

              <div className="space-y-0">
                <div className="flex items-center justify-between py-2.5">
                  <div className="flex-1">
                    <label className="text-sm font-medium">{t("settings.shortcut.showMain")}</label>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {t("settings.shortcut.showMainDesc")}
                    </p>
                  </div>
                  <ShortcutInput value={shortcut} onChange={handleShortcutChange} />
                </div>
              </div>
            </div>
          )}

          {activeSection === "project" && <ProjectSection />}

          {activeSection === "terminal" && <TerminalSection />}

          {activeSection === "data" && <DataSection />}

          {activeSection === "editor" && <EditorSection />}
        </div>
      </div>
    </WindowFrame>
  );
}

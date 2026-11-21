import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils.ts";
import { TitleBar } from "@/components/title-bar.tsx";
import { WindowFrame } from "@/components/window-frame.tsx";
import { AppearanceSection } from "./appearance-section.tsx";
import { ShortcutSection } from "./shortcut-section.tsx";
import { TerminalSection } from "./terminal-section.tsx";
import { PluginsSection } from "./plugins-section.tsx";
import { ProxySection } from "./proxy-section.tsx";
import { DataSection } from "./data-section.tsx";
import { FilePreviewSection } from "./file-preview-section.tsx";
import { EditorSection } from "./editor-section.tsx";
import { AiConfigSection } from "./ai-config-section.tsx";
import { CcsAppConfigSection } from "./ccs-app-config-section.tsx";
import { MdEditorSection } from "./md-editor-section.tsx";
import { PortsSection } from "./ports-section.tsx";
import { RuntimeSection } from "./runtime-section.tsx";
import { DownloadSection } from "./download-section.tsx";
import { CodegSection } from "./codeg-section.tsx";
import { OneMailSection } from "./one-mail-section.tsx";
import { TaskManagerSection } from "./task-manager-section.tsx";
import {
  Activity,
  Palette,
  Keyboard,
  SquareTerminal,
  Package,
  Database,
  Globe,
  ScanEye,
  SquarePen,
  FileText,
  Bot,
  Plug,
  Cpu,
  Download,
  Code2,
  Mail,
  Wrench,
} from "lucide-react";
import { CcSwitchLogo } from "@/components/icons/cc-switch-logo";
import { useAppTranslation } from "@/hooks/use-app-translation.ts";
import { DEV_BUILD } from "@/lib/dev-flag";
import {
  SETTINGS_SECTION_EVENT,
  type SettingsSectionPayload,
} from "@/lib/task-manager/settings-event";

type SettingSection =
  | "appearance"
  | "shortcut"
  | "terminal"
  | "plugins"
  | "proxy"
  | "data"
  | "filePreview"
  | "editor"
  | "mdEditor"
  | "aiConfig"
  | "ccs"
  | "ports"
  | "runtime"
  | "download"
  | "oneMail"
  | "taskManager"
  | "codeg"
  | "codegDev";

const SECTION_IDS: readonly SettingSection[] = [
  "appearance",
  "shortcut",
  "terminal",
  "plugins",
  "proxy",
  "data",
  "filePreview",
  "editor",
  "mdEditor",
  "aiConfig",
  "ccs",
  "ports",
  "runtime",
  "download",
  "oneMail",
  "taskManager",
  "codeg",
  "codegDev",
];

function isSettingSection(value: string | null): value is SettingSection {
  return value !== null && (SECTION_IDS as readonly string[]).includes(value);
}

/** The section named by `?section=`, so a deep link lands on the right pane. */
function initialSection(): SettingSection {
  const section = new URLSearchParams(window.location.search).get("section");
  return isSettingSection(section) ? section : "appearance";
}

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingSection>(initialSection);
  const { t } = useAppTranslation();

  // An already-open settings window is told to switch via this event rather
  // than reloading with a new URL.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<SettingsSectionPayload>(SETTINGS_SECTION_EVENT, (event) => {
      if (isSettingSection(event.payload.section)) setActiveSection(event.payload.section);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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
      id: "terminal" as SettingSection,
      label: t("settings.terminal.title"),
      icon: SquareTerminal,
    },
    {
      id: "plugins" as SettingSection,
      label: t("plugins.title"),
      icon: Package,
    },
    {
      id: "proxy" as SettingSection,
      label: t("settings.proxy.title"),
      icon: Globe,
    },
    {
      id: "download" as SettingSection,
      label: t("settings.download.title"),
      icon: Download,
    },
    {
      id: "oneMail" as SettingSection,
      label: t("oneMail.settings.title"),
      icon: Mail,
    },
    {
      id: "data" as SettingSection,
      label: t("data.title"),
      icon: Database,
    },
    {
      id: "filePreview" as SettingSection,
      label: t("settings.filePreview.title"),
      icon: ScanEye,
    },
    {
      id: "ccs" as SettingSection,
      label: "应用配置",
      icon: CcSwitchLogo,
    },
    {
      id: "editor" as SettingSection,
      label: t("editor.title"),
      icon: SquarePen,
    },
    {
      id: "mdEditor" as SettingSection,
      label: t("mdEditor.settings.title"),
      icon: FileText,
    },
    {
      id: "aiConfig" as SettingSection,
      label: t("settings.aiConfig.title"),
      icon: Bot,
    },
    {
      id: "ports" as SettingSection,
      label: t("ports.title"),
      icon: Plug,
    },
    {
      id: "taskManager" as SettingSection,
      label: t("taskManager.settings.menuLabel"),
      icon: Activity,
    },
    {
      id: "runtime" as SettingSection,
      label: t("runtime.title"),
      icon: Cpu,
    },
    {
      id: "codeg" as SettingSection,
      label: t("codeg.settings.title"),
      icon: Code2,
    },
    // A developer's partition: it edits the paths of a Codeg checkout, so a
    // packaged build has nothing for it to point at.
    ...(DEV_BUILD
      ? [
          {
            id: "codegDev" as SettingSection,
            label: t("codeg.settings.devTitle"),
            icon: Wrench,
          },
        ]
      : []),
  ];

  return (
    <WindowFrame
      titleBar={<TitleBar title={t("settings.title")} showPin showMaximize={false} />}
      contentClassName="flex flex-1 overflow-hidden"
    >
      <aside className="border-border flex w-[calc(10rem+5px)] flex-col border-r p-4">
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto">
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
        <div className="p-4">
          {activeSection === "appearance" && <AppearanceSection />}

          {activeSection === "shortcut" && <ShortcutSection />}

          {activeSection === "terminal" && <TerminalSection />}

          {activeSection === "plugins" && <PluginsSection />}

          {activeSection === "proxy" && <ProxySection />}

          {activeSection === "download" && <DownloadSection />}

          {activeSection === "oneMail" && <OneMailSection />}

          {activeSection === "data" && <DataSection />}

          {activeSection === "filePreview" && <FilePreviewSection />}

          {activeSection === "ccs" && <CcsAppConfigSection />}

          {activeSection === "editor" && <EditorSection />}

          {activeSection === "mdEditor" && <MdEditorSection />}

          {activeSection === "aiConfig" && <AiConfigSection />}

          {activeSection === "ports" && <PortsSection />}

          {activeSection === "taskManager" && <TaskManagerSection />}

          {activeSection === "runtime" && <RuntimeSection />}

          {activeSection === "codeg" && <CodegSection mode="installed" />}

          {activeSection === "codegDev" && <CodegSection mode="dev" />}
        </div>
      </div>
    </WindowFrame>
  );
}

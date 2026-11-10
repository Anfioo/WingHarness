import { useState } from "react";
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
import {
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
} from "lucide-react";
import { CcSwitchLogo } from "@/components/icons/cc-switch-logo";
import { useAppTranslation } from "@/hooks/use-app-translation.ts";

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
  | "ports";

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingSection>("appearance");
  const { t } = useAppTranslation();

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
        <div className="p-4">
          {activeSection === "appearance" && <AppearanceSection />}

          {activeSection === "shortcut" && <ShortcutSection />}

          {activeSection === "terminal" && <TerminalSection />}

          {activeSection === "plugins" && <PluginsSection />}

          {activeSection === "proxy" && <ProxySection />}

          {activeSection === "data" && <DataSection />}

          {activeSection === "filePreview" && <FilePreviewSection />}

          {activeSection === "ccs" && <CcsAppConfigSection />}

          {activeSection === "editor" && <EditorSection />}

          {activeSection === "mdEditor" && <MdEditorSection />}

          {activeSection === "aiConfig" && <AiConfigSection />}

          {activeSection === "ports" && <PortsSection />}
        </div>
      </div>
    </WindowFrame>
  );
}

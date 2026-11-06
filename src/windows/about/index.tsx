import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  BookOpen,
  CircleArrowUp,
  ExternalLink,
  Github,
  Mail,
  RefreshCw,
  Scale,
} from "lucide-react";
import logo from "@/assets/app-icons/wingharness-logo.svg";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TitleBar } from "@/components/title-bar.tsx";
import { WindowFrame } from "@/components/window-frame.tsx";
import { useAppTranslation } from "@/hooks/use-app-translation.ts";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cancelDestroyWindow, destroyWindow } from "@/lib/window.ts";
import { useManualUpdateCheck, useUpdater } from "@/hooks/use-updater";
import noticesEn from "../../../THIRD_PARTY_NOTICES.md?raw";
import noticesZh from "../../../THIRD_PARTY_NOTICES.zh-CN.md?raw";
import packageJson from "../../../package.json";

const techVersions = {
  tauri: packageJson.dependencies["@tauri-apps/api"].replace(/^\^/, "v"),
  react: packageJson.dependencies.react.replace(/^\^/, "v"),
  typescript: packageJson.devDependencies.typescript.replace(/^~/, "v"),
};

// The developer profile shown on the About card. Links open in the system
// browser through the opener plugin.
const AUTHOR = {
  name: "Anfioo",
  avatar: "https://github.com/Anfioo.png",
  github: "https://github.com/Anfioo",
  blog: "https://blog.csdn.net/m0_73579391",
  email: "anfioozys@gmail.com",
};

const REPO_URL = "https://github.com/Anfioo/WingHarness";

const TECH_CHIPS: { label: string; version?: string }[] = [
  { label: "Tauri", version: techVersions.tauri },
  { label: "React", version: techVersions.react },
  { label: "TypeScript", version: techVersions.typescript },
  { label: "Tailwind CSS", version: "v4" },
  { label: "shadcn/ui" },
];

/**
 * The upstream projects recorded in THIRD_PARTY_NOTICES.md. Keep this list in
 * step with that file: every ported subsystem gets a row, and the module path is
 * the crate or directory that carries the ported code.
 */
const UPSTREAMS: { name: string; license: string; url: string; module: string }[] = [
  {
    name: "angkorgit",
    license: "MIT",
    url: "https://github.com/cheat2001/angkorgit",
    module: "src-tauri/git-core",
  },
  {
    name: "cc-switch",
    license: "MIT",
    url: "https://github.com/farion1231/cc-switch",
    module: "src-tauri/src/ccs",
  },
  {
    name: "Frpilot",
    license: "MIT",
    url: "https://github.com/leapfu/frpilot",
    module: "src-tauri/frp-core",
  },
  {
    name: "jetbrains-cc-gui",
    license: "MIT",
    url: "https://github.com/zhukunpenglinyutong/jetbrains-cc-gui",
    module: "src/pages/claude-chat",
  },
  {
    name: "MangoDisk",
    license: "GPL-3.0-only",
    url: "https://github.com/harry0703/MangoDisk",
    module: "src-tauri/systools-core",
  },
  {
    name: "McpHub",
    license: "MIT",
    url: "https://github.com/Soflutionltd/McpHub",
    module: "src-tauri/src/mcphub",
  },
  {
    name: "OrcaSVN",
    license: "MIT",
    url: "https://github.com/wustites/OrcaSVN",
    module: "src-tauri/svn-core",
  },
  {
    name: "shaic",
    license: "MIT",
    url: "https://github.com/dariocurr/shaic",
    module: "src-tauri/shaic-core",
  },
  {
    name: "TizuMark",
    license: "GPL-3.0-only",
    url: "https://github.com/tizuio/TizuMark-Markdown-Editor",
    module: "src-tauri/md-editor-core",
  },
  {
    name: "tweakcn",
    license: "Apache-2.0",
    url: "https://github.com/jnsahaj/tweakcn",
    module: "src/lib/theme",
  },
  {
    name: "use-claude",
    license: "MIT",
    url: "https://github.com/ekaone/use-claude",
    module: "src/lib/use-claude",
  },
  {
    name: "XTerm",
    license: "MIT",
    url: "https://github.com/Rockytkg/XTerm",
    module: "src-tauri/server-core",
  },
];

export default function AboutPage() {
  const [appVersion, setAppVersion] = useState("");
  const [licensesOpen, setLicensesOpen] = useState(false);
  const { t, language } = useAppTranslation();
  const { checkUpdate, checking, downloading, showNoUpdate } = useManualUpdateCheck();
  const { availableVersion } = useUpdater();

  useEffect(() => {
    void getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWebviewWindow();

    const unlistenClose = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      console.log("About window close requested, will destroy in 5 seconds");
      await destroyWindow(appWindow.label, 5000);
    });

    const unlistenFocusChanged = appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        cancelDestroyWindow(appWindow.label);
      }
    });

    return () => {
      unlistenClose.then((fn) => fn());
      unlistenFocusChanged.then((fn) => fn());
    };
  }, []);

  const links = [
    { icon: Github, label: t("about.github"), href: AUTHOR.github },
    { icon: BookOpen, label: t("about.blog"), href: AUTHOR.blog },
    { icon: Mail, label: t("about.email"), href: `mailto:${AUTHOR.email}` },
  ];

  return (
    <WindowFrame
      titleBar={
        <TitleBar title={t("about.title")} showPin showMinimize={false} showMaximize={false} />
      }
      contentClassName="flex flex-1 flex-col overflow-y-auto"
    >
      <div className="flex flex-col gap-5 px-6 py-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src={logo} alt={t("about.appName")} className="size-16 rounded-2xl shadow-sm" />
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">{t("about.appName")}</h2>
            <div className="flex items-center justify-center gap-2">
              <Badge variant="secondary" className="font-mono">
                {appVersion ? `v${appVersion}` : "—"}
              </Badge>
              {availableVersion && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="destructive" className="gap-1">
                        <CircleArrowUp />
                        {t("updater.updateAvailable")}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("updater.versionAvailable", { version: availableVersion })}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
          <p className="text-muted-foreground max-w-sm text-sm text-balance">
            {t("about.description")}
          </p>
        </div>

        <Separator />

        <section className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t("about.techStack")}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {TECH_CHIPS.map((chip) => (
              <Badge key={chip.label} variant="outline" className="gap-1.5">
                {chip.label}
                {chip.version && (
                  <span className="text-muted-foreground font-mono">{chip.version}</span>
                )}
              </Badge>
            ))}
          </div>
        </section>

        <Separator />

        <section className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t("about.developer")}
          </h3>
          <div className="bg-muted/40 border-border/60 rounded-xl border p-3">
            <div className="flex items-center gap-3">
              <Avatar className="size-11">
                <AvatarImage src={AUTHOR.avatar} alt={AUTHOR.name} />
                <AvatarFallback>AN</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{AUTHOR.name}</span>
                  <Badge variant="secondary" className="px-1.5">
                    {t("about.role")}
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs italic">{t("about.bio")}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {links.map(({ icon: Icon, label, href }) => (
                <Button
                  key={label}
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => void openUrl(href)}
                >
                  <Icon />
                  {label}
                </Button>
              ))}
            </div>
          </div>
        </section>

        <div className="flex flex-col gap-2">
          <Button variant="outline" className="w-full" onClick={() => void openUrl(REPO_URL)}>
            <Github />
            {t("about.viewRepo")}
          </Button>
          <Button variant="outline" className="w-full" onClick={() => setLicensesOpen(true)}>
            <Scale />
            {t("about.thirdParty")}
          </Button>
          <Button onClick={checkUpdate} className="w-full" variant="outline" disabled={checking}>
            <RefreshCw className={checking || downloading ? "animate-spin" : undefined} />
            {checking
              ? t("updater.checking")
              : downloading
                ? t("updater.updating")
                : t("updater.checkForUpdates")}
          </Button>
          {showNoUpdate && (
            <p className="text-muted-foreground text-center text-sm">{t("updater.upToDate")}</p>
          )}
        </div>

        <Dialog open={licensesOpen} onOpenChange={setLicensesOpen}>
          <DialogContent className="sm:max-w-[460px]">
            <DialogHeader>
              <DialogTitle>{t("about.licensesTitle")}</DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-2">
                {t("about.licensesDescription")}
                <Badge variant="secondary" className="font-mono">
                  GPL-3.0-only
                </Badge>
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="sources" className="flex min-h-0 flex-col">
              <TabsList className="w-full">
                <TabsTrigger value="sources" className="flex-1">
                  {t("about.licenseSources")}
                </TabsTrigger>
                <TabsTrigger value="notices" className="flex-1">
                  {t("about.licenseNotices")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="sources" className="mt-2">
                <ul className="max-h-[340px] space-y-2 overflow-y-auto pr-1">
                  {UPSTREAMS.map((project) => (
                    <li
                      key={project.name}
                      className="border-border/60 flex items-start gap-2 rounded-lg border p-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{project.name}</span>
                          <Badge
                            variant="secondary"
                            className="shrink-0 px-1.5 font-mono text-[10px]"
                          >
                            {project.license}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
                          {project.module}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={t("about.licenseOpen", { name: project.name })}
                        onClick={() => void openUrl(project.url)}
                      >
                        <ExternalLink />
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-3 text-xs">{t("about.licenseBundled")}</p>
              </TabsContent>

              <TabsContent value="notices" className="mt-2">
                <pre className="bg-muted/40 border-border/60 max-h-[360px] overflow-auto rounded-lg border p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
                  {language.startsWith("zh") ? noticesZh : noticesEn}
                </pre>
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>
      </div>
    </WindowFrame>
  );
}

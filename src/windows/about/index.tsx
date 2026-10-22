import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { BookOpen, CircleArrowUp, Github, Mail, RefreshCw } from "lucide-react";
import logo from "@/assets/app-icons/wingharness-logo.svg";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TitleBar } from "@/components/title-bar.tsx";
import { WindowFrame } from "@/components/window-frame.tsx";
import { useAppTranslation } from "@/hooks/use-app-translation.ts";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cancelDestroyWindow, destroyWindow } from "@/lib/window.ts";
import { useManualUpdateCheck, useUpdater } from "@/hooks/use-updater";
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

export default function AboutPage() {
  const [appVersion, setAppVersion] = useState("");
  const { t } = useAppTranslation();
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
      </div>
    </WindowFrame>
  );
}

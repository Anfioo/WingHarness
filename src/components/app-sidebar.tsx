import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import logo from "@/assets/app-icons/wingharness-logo.svg";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { AppRoute } from "@/lib/app-routes";
import { useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { MouseEvent as ReactMouseEvent } from "react";

type AppSidebarProps = {
  routes: AppRoute[];
  activePath: string;
};

/** Only a plain left click is ours to intercept; leave modified clicks alone. */
function isPlainLeftClick(event: ReactMouseEvent<HTMLAnchorElement>) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function RouteList({
  label,
  routes,
  activePath,
}: {
  label: string;
  routes: AppRoute[];
  activePath: string;
}) {
  const { navigate } = useRouter();
  const { t } = useAppTranslation();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {routes.map((route) => {
            const Icon = route.icon;
            const title = t(`routes.${route.id}.title`);
            const isActive = route.path === activePath;

            return (
              <SidebarMenuItem key={route.id}>
                <SidebarMenuButton
                  asChild
                  tooltip={title}
                  isActive={isActive}
                  className={cn(isActive && "font-medium")}
                >
                  <a
                    href={route.path}
                    onClick={(event) => {
                      if (!isPlainLeftClick(event)) return;
                      event.preventDefault();
                      navigate(route.path);
                    }}
                  >
                    <Icon />
                    <span>{title}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar({ routes, activePath }: AppSidebarProps) {
  const { t } = useAppTranslation();

  return (
    <Sidebar
      collapsible="icon"
      className="top-8 h-[calc(100svh-2rem)] overflow-hidden rounded-bl-lg"
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip={t("app.title")}>
              <img src={logo} alt="" className="size-8 rounded-lg" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{t("app.title")}</span>
                <span className="text-muted-foreground truncate text-xs">{t("app.subtitle")}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <RouteList label={t("routes.group")} routes={routes} activePath={activePath} />
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}

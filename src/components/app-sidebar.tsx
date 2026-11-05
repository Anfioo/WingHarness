import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronRight, ChevronsUpDown, LogOut, Package, Sparkles, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import logo from "@/assets/app-icons/wingharness-logo.svg";
import { cn } from "@/lib/utils";
import { appRoutes } from "@/lib/app-routes";
import { useRouter } from "@/lib/router";
import { usePluginsStore } from "@/hooks/use-plugins-store";
import { useCustomIcons } from "@/hooks/use-custom-icons";
import { useSidebarStore } from "@/hooks/use-sidebar-store";
import {
  PLUGIN_FOCUS_PATH,
  resolveSidebar,
  type ResolvedLeaf,
  type ResolvedParent,
} from "@/lib/sidebar-config";

type AppSidebarProps = {
  activePath: string;
};

const sidebarUser = {
  name: "Guest User",
  email: "guest@wingharness.local",
  initials: "GU",
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

export function AppSidebar({ activePath }: AppSidebarProps) {
  const { search } = useRouter();
  const activePluginId = new URLSearchParams(search).get("id");
  const { config } = useSidebarStore();
  const { plugins } = usePluginsStore();
  const { byName: customIcons } = useCustomIcons();

  // Routes resolve from the static table, plugins from the store, so an entry
  // whose target is gone simply does not appear.
  const groups = useMemo(
    () => (config ? resolveSidebar(config, appRoutes, plugins, customIcons) : []),
    [config, plugins, customIcons]
  );

  const isLeafActive = (leaf: ResolvedLeaf) =>
    leaf.kind === "route"
      ? leaf.href === activePath
      : activePath === PLUGIN_FOCUS_PATH && leaf.ref === activePluginId;

  return (
    <Sidebar
      collapsible="icon"
      className="top-8 h-[calc(100svh-2rem)] overflow-hidden rounded-bl-lg"
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip="WingHarness">
              <img src={logo} alt="" className="size-8 rounded-lg" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">WingHarness</span>
                <span className="text-muted-foreground truncate text-xs">Desktop Template</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.id}>
            <SidebarGroupLabel>{group.name}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) =>
                  item.kind === "parent" ? (
                    <ParentEntry
                      key={item.id}
                      parent={item}
                      activeChildId={item.children.find((child) => isLeafActive(child))?.id ?? null}
                    />
                  ) : (
                    <LeafEntry key={item.id} leaf={item} active={isLeafActive(item)} sub={false} />
                  )
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarUserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/**
 * One page: a route's or a plugin's.
 *
 * A plugin's page draws a native webview owned by the window. Unless pages are
 * cached, leaving the page unmounts its `PluginBrowser`, whose cleanup releases
 * that webview, so an in-app navigation is enough — no document reload needed.
 */
function LeafEntry({ leaf, active, sub }: { leaf: ResolvedLeaf; active: boolean; sub: boolean }) {
  const { navigate } = useRouter();
  const Icon = leaf.icon;
  const className = cn(active && "font-medium");

  const link = (
    <a
      href={leaf.href}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        navigate(leaf.href);
      }}
    >
      <Icon
        className="size-4 shrink-0"
        style={leaf.iconColor ? { color: leaf.iconColor } : undefined}
      />
      <span className="truncate">{leaf.label}</span>
    </a>
  );

  if (sub) {
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton asChild isActive={active} className={className}>
          {link}
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={leaf.label} isActive={active} className={className}>
        {link}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * A first-level entry that holds the second level.
 *
 * While one of its children is the page being shown, the row folds and unfolds
 * the children — the page stays where it is. From anywhere else it opens the
 * default child, since a parent has no page of its own. The row is never
 * highlighted: that is the leaf's job.
 */
function ParentEntry({
  parent,
  activeChildId,
}: {
  parent: ResolvedParent;
  activeChildId: string | null;
}) {
  const { navigate } = useRouter();
  // `null` follows the current page; a fold the user asked for is remembered
  // until they navigate elsewhere.
  const [open, setOpen] = useState<boolean | null>(null);
  const containsActive = activeChildId !== null;
  const expanded = open ?? containsActive;

  const onClick = () => {
    if (containsActive) {
      setOpen(!expanded);
      return;
    }

    setOpen(true);
    const target = parent.children.find((child) => child.id === parent.defaultChildId);
    if (target) navigate(target.href);
  };

  const Icon = parent.icon ?? Package;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip={parent.name} onClick={onClick}>
        <Icon
          className="size-4 shrink-0"
          style={parent.iconColor ? { color: parent.iconColor } : undefined}
        />
        <span className="truncate">{parent.name}</span>
        <span
          role="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
          className="hover:bg-sidebar-accent-foreground/10 ms-auto -me-1 flex size-6 shrink-0 items-center justify-center rounded-md group-data-[collapsible=icon]:hidden"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(!expanded);
          }}
        >
          <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
        </span>
      </SidebarMenuButton>

      {expanded && (
        <SidebarMenuSub>
          {parent.children.map((child) => (
            <LeafEntry key={child.id} leaf={child} active={child.id === activeChildId} sub />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

function SidebarUserMenu() {
  const { isMobile } = useSidebar();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-full text-xs font-semibold">
                {sidebarUser.initials}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{sidebarUser.name}</span>
                <span className="text-muted-foreground truncate text-xs">{sidebarUser.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-full text-xs font-semibold">
                  {sidebarUser.initials}
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{sidebarUser.name}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {sidebarUser.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem>
                <UserRound />
                用户中心
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Sparkles />
                升级用户
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <LogOut />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

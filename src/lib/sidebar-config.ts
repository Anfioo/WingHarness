import { Package } from "lucide-react";
import {
  type AppRoute,
  type AppRouteGroup,
  type AppRouteIcon,
  type AppRouteId,
} from "@/lib/app-routes";
import { resolveIcon } from "@/lib/icon-set";
import type {
  PluginView,
  SidebarConfig,
  SidebarGroup,
  SidebarItem,
  SidebarLeafItem,
  SidebarPluginItem,
  SidebarRouteItem,
} from "@/commands";

/** Group labels the sidebar starts with, before anything is rearranged. */
export const DEFAULT_GROUP_NAMES: Record<AppRouteGroup, string> = {
  workspace: "工作台",
  ecosystem: "高级生态",
  agents: "Agent",
  plugins: "插件",
  // The servers group exists only so `AppRoute.group` stays exhaustive: it is
  // deliberately absent from GROUP_ORDER, so the entry lands in 「其他」.
  servers: "服务器",
  // Same deal as `servers`: named here for type completeness, kept out of
  // GROUP_ORDER so the FRP console lands in 「其他」.
  frp: "FRP",
  // Same deal again: the Markdown editor is listed in 「其他」.
  mdEditor: "Markdown",
  // Same deal again: the ports page is listed in 「其他」.
  ports: "端口",
  moin: "下载",
};

/** Name of the group that collects entries no group refers to. */
export const OTHER_GROUP_NAME = "其他";

/** Id of the computed group above; never written to the layout file. */
export const OTHER_GROUP_ID = "__other__";

/** Ids are stable per target, so writing the layout twice yields the same file. */
export const routeItemId = (route: string) => `route:${route}`;
export const pluginItemId = (plugin: string) => `plugin:${plugin}`;

/**
 * The path a plugin's own page is drawn at, with the plugin in `?id=`. It has no
 * entry in the route table, so the sidebar builds the URL itself.
 */
export const PLUGIN_FOCUS_PATH = "/plugin-focus";

/** The subtitle a plugin's page falls back to: its name and version. */
export const pluginTagline = (plugin: PluginView) =>
  plugin.version ? `${plugin.name} ${plugin.version}` : plugin.name;

const GROUP_ORDER: AppRouteGroup[] = ["workspace", "ecosystem", "agents", "plugins"];

/** A plugin earns a sidebar entry only when it can actually show a page. */
export function sidebarReady(plugin: PluginView): boolean {
  return plugin.error === null && plugin.enabled && (plugin.ui?.length ?? 0) > 0;
}

/**
 * The layout a fresh install starts with: every built-in page in its route
 * group.
 *
 * Plugins start out under the plugins page's tabs. The manager is where a
 * plugin is dragged into the sidebar, so a new install has nothing to guess.
 */
export function buildDefaultConfig(routes: AppRoute[]): SidebarConfig {
  const groups: SidebarGroup[] = GROUP_ORDER.map((group) => ({
    id: `group:${group}`,
    name: DEFAULT_GROUP_NAMES[group],
    items: routes
      .filter((route) => route.group === group)
      .map(
        (route): SidebarLeafItem => ({ kind: "route", id: routeItemId(route.id), route: route.id })
      ),
  }));

  return { version: 1, groups };
}

/** One entry the sidebar can draw, with everything it needs already resolved. */
export type ResolvedLeaf = {
  kind: "route" | "plugin";
  /** Entry id from the layout file. */
  id: string;
  /** Route id or plugin id. */
  ref: string;
  label: string;
  icon: AppRouteIcon;
  /** The entry's chosen colour, or `null` for the theme's own. */
  iconColor: string | null;
  href: string;
};

export type ResolvedParent = {
  kind: "parent";
  id: string;
  name: string;
  /** The parent's own icon, or its default child's when it has none of its own. */
  icon: AppRouteIcon | null;
  /** The parent's chosen colour, or `null` for the theme's own. */
  iconColor: string | null;
  /** Resolved id of the child a click opens; `null` when there are none. */
  defaultChildId: string | null;
  children: ResolvedLeaf[];
};

export type ResolvedItem = ResolvedLeaf | ResolvedParent;

export type ResolvedGroup = {
  id: string;
  name: string;
  items: ResolvedItem[];
};

/** Route ids and plugin ids the layout refers to, wherever they sit. */
export function placedIds(config: SidebarConfig): {
  routes: Set<string>;
  plugins: Set<string>;
} {
  const routes = new Set<string>();
  const plugins = new Set<string>();

  const visit = (item: SidebarItem) => {
    if (item.kind === "route") routes.add(item.route);
    else if (item.kind === "plugin") plugins.add(item.plugin);
    else item.children.forEach(visit);
  };

  config.groups.forEach((group) => group.items.forEach(visit));
  return { routes, plugins };
}

/**
 * The layout entry for a built-in page, which is where that page's custom name,
 * icon, subtitle, and note are kept. `null` while the page sits in 其他, or
 * before the layout has loaded.
 */
export function routeOverride(
  config: SidebarConfig | null,
  routeId: string
): SidebarRouteItem | null {
  if (!config) return null;

  for (const leaf of placedLeaves(config)) {
    if (leaf.kind === "route" && leaf.route === routeId) return leaf;
  }
  return null;
}

/** The layout entry for a plugin's page, holding the same overrides. */
export function pluginOverride(
  config: SidebarConfig | null,
  pluginId: string
): SidebarPluginItem | null {
  if (!config) return null;

  for (const leaf of placedLeaves(config)) {
    if (leaf.kind === "plugin" && leaf.plugin === pluginId) return leaf;
  }
  return null;
}

/** Every leaf the layout places, parents flattened, in sidebar order. */
function* placedLeaves(config: SidebarConfig): Generator<SidebarLeafItem> {
  for (const group of config.groups) {
    for (const item of group.items) {
      if (item.kind === "parent") yield* item.children;
      else yield item;
    }
  }
}

/**
 * Turns the layout into what the sidebar draws.
 *
 * Entries whose target no longer exists are dropped rather than rendered as a
 * dead row — a route removed in code, an uninstalled plugin, or one that is
 * disabled right now. The layout keeps them, so re-enabling brings them back.
 * The left-over built-in pages are collected into a trailing 其他 group.
 *
 * `customIcons` maps a file stem to the SVG component the icons folder holds;
 * without it (before the folder has been read) a `custom:` entry falls back to
 * its page's own icon.
 */
export function resolveSidebar(
  config: SidebarConfig,
  routes: AppRoute[],
  plugins: PluginView[],
  customIcons?: Map<string, AppRouteIcon>
): ResolvedGroup[] {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));

  const leafOf = (item: SidebarLeafItem): ResolvedLeaf | null => {
    if (item.kind === "route") {
      const route = routeById.get(item.route as AppRouteId);
      if (!route) return null;
      return {
        kind: "route",
        id: item.id,
        ref: route.id,
        label: item.label ?? route.navLabel,
        icon: resolveIcon(item.icon, customIcons) ?? route.icon,
        iconColor: item.iconColor ?? null,
        href: route.path,
      };
    }

    const plugin = pluginById.get(item.plugin);
    if (!plugin || !sidebarReady(plugin)) return null;
    return {
      kind: "plugin",
      id: item.id,
      ref: plugin.id,
      label: item.label ?? plugin.name,
      icon: resolveIcon(item.icon, customIcons) ?? Package,
      iconColor: item.iconColor ?? null,
      href: `${PLUGIN_FOCUS_PATH}?id=${encodeURIComponent(plugin.id)}`,
    };
  };

  const resolveItem = (item: SidebarItem): ResolvedItem | null => {
    if (item.kind !== "parent") return leafOf(item);

    const children = item.children
      .map(leafOf)
      .filter((child): child is ResolvedLeaf => child !== null);
    if (children.length === 0) return null;

    // A dangling default would leave the parent with nothing to open; the first
    // child is always a safe answer.
    const wanted = item.defaultChild;
    const defaultChild = children.find((child) => child.id === wanted) ?? children[0];

    return {
      kind: "parent",
      id: item.id,
      name: item.name,
      icon: resolveIcon(item.icon, customIcons) ?? defaultChild.icon,
      iconColor: item.iconColor ?? null,
      defaultChildId: defaultChild.id,
      children,
    };
  };

  const groups: ResolvedGroup[] = config.groups
    .map((group) => ({
      id: group.id,
      name: group.name,
      items: group.items.map(resolveItem).filter((item): item is ResolvedItem => item !== null),
    }))
    .filter((group) => group.items.length > 0);

  const placed = placedIds(config);
  const other: ResolvedLeaf[] = [];
  for (const route of routes) {
    if (placed.routes.has(route.id)) continue;
    other.push({
      kind: "route",
      id: routeItemId(route.id),
      ref: route.id,
      label: route.navLabel,
      icon: route.icon,
      iconColor: null,
      href: route.path,
    });
  }
  if (other.length > 0) {
    groups.push({ id: OTHER_GROUP_ID, name: OTHER_GROUP_NAME, items: other });
  }

  return groups;
}

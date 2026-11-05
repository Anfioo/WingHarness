/**
 * The main window's sidebar layout.
 *
 * Groups hold first-level entries; an entry is either a page of its own or a
 * parent whose children are the second level. A parent has no target — a click
 * opens its `defaultChild`. Order is the array order; nothing carries a sort
 * index.
 */
export interface SidebarConfig {
  /** Schema version, so a later shape change can migrate instead of guess. */
  version: number;
  /**
   * Keep each page mounted after the user moves on, so coming back finds it as
   * they left it. Absent means off.
   */
  cachePages?: boolean;
  groups: SidebarGroup[];
}

export interface SidebarGroup {
  id: string;
  name: string;
  items: SidebarItem[];
}

/** A built-in page, referenced by route id rather than by path. */
export interface SidebarRouteItem {
  kind: "route";
  id: string;
  /** An `AppRouteId`. */
  route: string;
  /** Custom name; the page's own name is used when unset. */
  label?: string | null;
  /** Icon name from the picker's catalog; the page's own icon is used when unset. */
  icon?: string | null;
  /** CSS colour for the icon; the theme's own colour is used when unset. */
  iconColor?: string | null;
  /** Custom subtitle for the page header; the page's own summary is used when unset. */
  scope?: string | null;
  /** Custom text for the header's question mark; the page's own note is used when unset. */
  notes?: string | null;
}

/** A plugin's page, referenced by the plugin's id. */
export interface SidebarPluginItem {
  kind: "plugin";
  id: string;
  plugin: string;
  /** Custom name; the plugin's own name is used when unset. */
  label?: string | null;
  /** Icon name from the picker's catalog; the plugin is drawn with a package when unset. */
  icon?: string | null;
  /** CSS colour for the icon; the theme's own colour is used when unset. */
  iconColor?: string | null;
  /** Custom subtitle for the page header; the plugin's name and version are used when unset. */
  scope?: string | null;
  /** Custom text for the header's question mark; the plugin's own description is used when unset. */
  notes?: string | null;
}

/** A container that opens one of its children. */
export interface SidebarParentItem {
  kind: "parent";
  id: string;
  name: string;
  /** Custom icon; the default child's icon is used when unset. */
  icon?: string | null;
  /** CSS colour for the icon; the theme's own colour is used when unset. */
  iconColor?: string | null;
  /** Id of the child a click on the parent opens; `null` falls back to the first. */
  defaultChild: string | null;
  /** Second-level entries. A parent may not hold another parent. */
  children: SidebarLeafItem[];
}

export type SidebarLeafItem = SidebarRouteItem | SidebarPluginItem;
export type SidebarItem = SidebarLeafItem | SidebarParentItem;

/** One SVG the picker offers, read from the icons folder. */
export interface SidebarCustomIcon {
  /** File stem; the layout stores it as `custom:<name>`. */
  name: string;
  /** The document text, which the frontend turns into a data URL. */
  svg: string;
}

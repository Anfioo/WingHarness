import {
  FileSearch,
  FolderKanban,
  LayoutDashboard,
  NotebookPen,
  SquareTerminal,
} from "lucide-react";
import type { ComponentType } from "react";

/** What the sidebar and the header need from an icon: a `className` it accepts. */
export type AppRouteIcon = ComponentType<{ className?: string }>;

export type AppRouteId = "start" | "localTerminal" | "notes" | "filePreview" | "project";

export type AppRoute = {
  id: AppRouteId;
  path: string;
  icon: AppRouteIcon;
};

/**
 * The main window's pages, in the order the sidebar lists them.
 *
 * The table carries no prose: everything the sidebar and the header print about
 * a route is looked up under `routes.<id>` in the locale files, so the two
 * languages cannot drift apart from this list.
 */
export const appRoutes: AppRoute[] = [
  { id: "start", path: "/", icon: LayoutDashboard },
  { id: "localTerminal", path: "/local-terminal", icon: SquareTerminal },
  { id: "notes", path: "/notes", icon: NotebookPen },
  { id: "filePreview", path: "/file-preview", icon: FileSearch },
  { id: "project", path: "/project", icon: FolderKanban },
];

/** The route for a pathname, falling back to the start page for anything else. */
export function getAppRouteByPath(pathname: string) {
  return appRoutes.find((route) => route.path === pathname) ?? appRoutes[0];
}

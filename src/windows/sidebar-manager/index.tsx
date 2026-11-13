import {
  Component,
  createContext,
  createElement,
  Fragment,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  closestCenter,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, GripVertical, Layers, Package, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { PluginView, SidebarConfig, SidebarItem, SidebarLeafItem } from "@/commands";
import { IconPicker } from "@/components/icon-picker";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useCustomIcons } from "@/hooks/use-custom-icons";
import { usePluginsStore } from "@/hooks/use-plugins-store";
import { useSidebarStore } from "@/hooks/use-sidebar-store";
import { appRoutes, type AppRoute, type AppRouteIcon } from "@/lib/app-routes";
import { resolveIcon } from "@/lib/icon-set";
import {
  placedIds,
  pluginItemId,
  pluginTagline,
  routeItemId,
  sidebarReady,
} from "@/lib/sidebar-config";
import { cn } from "@/lib/utils";

/**
 * Drag ids are namespaced: groups and entries sit in the same {@link DndContext},
 * and a box is a drop target rather than something that moves. The prefixes are
 * parsed back in `onDragEnd`.
 */
const GROUP_SORT = "grp:";
const ITEM_SORT = "itm:";
const BOX = "box:";

/** Droppable key for the two lists that sit outside the saved layout. */
const OTHER_BOX = "other";
const POOL_BOX = "pool";

const sortGroupId = (id: string) => `${GROUP_SORT}${id}`;
const sortItemId = (id: string) => `${ITEM_SORT}${id}`;
const boxId = (key: string) => `${BOX}${key}`;
const groupBox = (id: string) => `group:${id}`;
const parentBox = (id: string) => `parent:${id}`;
/** A group's title row: dropping there puts an entry first in that group. */
const headBox = (id: string) => `head:${id}`;

/** Where a dragged entry would land. */
interface DropTarget {
  /** `group:<id>`, `parent:<id>`, `other`, or `pool`. */
  box: string;
  index: number;
}

/** What kind of thing is being dragged. */
type DragKind = "group" | "parent" | "leaf";

/** The landing spot under the pointer, used to draw the drag-time markers. */
interface DropPreview {
  /** The target box, or `null` while the groups themselves are reordered. */
  box: string | null;
  /** The group highlighted during a group reorder. */
  groupId: string | null;
  /** Where the marker is drawn among the box's current entries. */
  insertAt: number;
  /** The box refuses the entry: a parent cannot become a second-level entry. */
  invalid: boolean;
  /** The box the entry already sits in — dnd-kit opens its gap there already. */
  from: string | null;
}

interface DragState {
  kind: DragKind | null;
  preview: DropPreview | null;
}

/**
 * The drag-time state the lists read to draw their markers. It is derived from
 * the same `dropTarget` resolution the drop itself uses, so a marker can never
 * promise a landing spot the drop would not honour.
 */
const DragStateContext = createContext<DragState>({ kind: null, preview: null });

function samePreview(a: DropPreview | null, b: DropPreview | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.box === b.box &&
    a.groupId === b.groupId &&
    a.insertAt === b.insertAt &&
    a.invalid === b.invalid &&
    a.from === b.from
  );
}

/** What kind of thing an id being dragged stands for. */
function dragKindOf(config: SidebarConfig, activeId: string): DragKind | null {
  if (activeId.startsWith(GROUP_SORT)) return "group";
  if (!activeId.startsWith(ITEM_SORT)) return null;
  const item = findItem(config, activeId.slice(ITEM_SORT.length));
  if (!item) return "leaf";
  return item.kind === "parent" ? "parent" : "leaf";
}

/** The route, plugin, and custom-icon tables the board needs to label entries. */
interface Catalog {
  routes: Map<string, AppRoute>;
  plugins: Map<string, PluginView>;
  /** Custom SVGs from the icons folder, by file stem. */
  custom: Map<string, AppRouteIcon>;
}

/** What the dialog is asking for. */
type Draft =
  | { mode: "newGroup" }
  | { mode: "renameGroup"; id: string; name: string }
  | { mode: "deleteGroup"; id: string; name: string }
  | { mode: "newParent"; groupId: string }
  /**
   * A menu entry or a parent. A parent's name is required; a leaf's is an
   * override, so leaving it empty keeps the page's own name. A leaf also edits
   * the page header's two lines.
   */
  | { mode: "editItem"; id: string; parent: boolean };

let idCounter = 0;
const newId = (prefix: string) => `${prefix}:${Date.now().toString(36)}${idCounter++}`;

/** The entries stored in a box; empty for the two boxes outside the layout. */
function boxItems(config: SidebarConfig, box: string): SidebarItem[] | null {
  if (box === OTHER_BOX || box === POOL_BOX) return [];
  // A group's title row holds the same entries as the group itself.
  if (box.startsWith("group:") || box.startsWith("head:")) {
    const group = config.groups.find(
      (item) => groupBox(item.id) === box || headBox(item.id) === box
    );
    return group ? group.items : null;
  }
  if (box.startsWith("parent:")) {
    for (const group of config.groups) {
      for (const item of group.items) {
        if (item.kind === "parent" && parentBox(item.id) === box) return item.children;
      }
    }
    return null;
  }
  return null;
}

/** Which box an entry is in, and where. */
function locate(config: SidebarConfig, itemId: string): DropTarget | null {
  for (const group of config.groups) {
    const index = group.items.findIndex((item) => item.id === itemId);
    if (index >= 0) return { box: groupBox(group.id), index };

    for (const item of group.items) {
      if (item.kind !== "parent") continue;
      const childIndex = item.children.findIndex((child) => child.id === itemId);
      if (childIndex >= 0) return { box: parentBox(item.id), index: childIndex };
    }
  }
  return null;
}

/** Resolves whatever sits under the pointer to a place in the layout. */
function dropTarget(config: SidebarConfig, overId: string): DropTarget | null {
  if (overId.startsWith(BOX)) {
    const box = overId.slice(BOX.length);
    const items = boxItems(config, box);
    if (!items) return null;
    // A title row means "first in the group"; the rest of the box means "last".
    return { box, index: box.startsWith("head:") ? 0 : items.length };
  }
  if (overId.startsWith(ITEM_SORT)) {
    return locate(config, overId.slice(ITEM_SORT.length));
  }
  if (overId.startsWith(GROUP_SORT)) {
    const id = overId.slice(GROUP_SORT.length);
    const group = config.groups.find((item) => item.id === id);
    return group ? { box: groupBox(id), index: group.items.length } : null;
  }
  return null;
}

/** The group an id sits in, wherever the id points. */
function groupOf(config: SidebarConfig, overId: string): string | null {
  if (overId.startsWith(GROUP_SORT)) {
    const id = overId.slice(GROUP_SORT.length);
    return config.groups.some((group) => group.id === id) ? id : null;
  }

  if (overId.startsWith(ITEM_SORT)) {
    const placed = locate(config, overId.slice(ITEM_SORT.length));
    if (!placed) return null;
    if (placed.box.startsWith("group:")) return placed.box.slice("group:".length);
    if (!placed.box.startsWith("parent:")) return null;

    const parentId = placed.box.slice("parent:".length);
    const owner = config.groups.find((group) =>
      group.items.some((item) => item.kind === "parent" && item.id === parentId)
    );
    return owner?.id ?? null;
  }

  if (overId.startsWith(BOX)) {
    const box = overId.slice(BOX.length);
    if (box.startsWith("group:")) return box.slice("group:".length);
    if (box.startsWith("head:")) return box.slice("head:".length);
    if (!box.startsWith("parent:")) return null;

    const parentId = box.slice("parent:".length);
    const owner = config.groups.find((group) =>
      group.items.some((item) => item.kind === "parent" && item.id === parentId)
    );
    return owner?.id ?? null;
  }

  return null;
}

/** Keeps every parent's default child pointing at one of its own entries. */
function normalizeDefaults(config: SidebarConfig): SidebarConfig {
  for (const group of config.groups) {
    for (const item of group.items) {
      if (item.kind !== "parent") continue;
      const ids = item.children.map((child) => child.id);
      if (!item.defaultChild || !ids.includes(item.defaultChild)) {
        item.defaultChild = ids[0] ?? null;
      }
    }
  }
  return config;
}

/**
 * Moves an entry to a box, or out of the layout when the box is one of the two
 * lists at the bottom.
 *
 * Returns `null` for a move that has no meaning: a parent cannot become a
 * second-level entry.
 */
function moveItem(config: SidebarConfig, itemId: string, target: DropTarget): SidebarConfig | null {
  const source = locate(config, itemId);
  if (!source) return null;

  const sourceItems = boxItems(config, source.box);
  if (!sourceItems) return null;
  const item = sourceItems[source.index];
  if (!item) return null;

  if (item.kind === "parent" && target.box.startsWith("parent:")) return null;

  if (source.box === target.box) {
    if (source.index === target.index) return config;
    const reordered = arrayMove(sourceItems, source.index, target.index);
    sourceItems.splice(0, sourceItems.length, ...reordered);
    return config;
  }

  sourceItems.splice(source.index, 1);

  if (target.box === OTHER_BOX || target.box === POOL_BOX) return normalizeDefaults(config);

  const targetItems = boxItems(config, target.box);
  if (!targetItems) return null;

  targetItems.splice(Math.min(target.index, targetItems.length), 0, item);
  return normalizeDefaults(config);
}

/** Adds an entry that is not in the layout yet — one from 其他 or the pool. */
function insertLeaf(
  config: SidebarConfig,
  leaf: SidebarLeafItem,
  target: DropTarget
): SidebarConfig | null {
  if (target.box === OTHER_BOX || target.box === POOL_BOX) return null;
  const targetItems = boxItems(config, target.box);
  if (!targetItems) return null;

  targetItems.splice(Math.min(target.index, targetItems.length), 0, leaf);
  return normalizeDefaults(config);
}

function labelOf(item: SidebarItem, catalog: Catalog): string {
  if (item.kind === "parent") return item.name;
  if (item.kind === "route") {
    return item.label ?? catalog.routes.get(item.route)?.navLabel ?? item.route;
  }
  return item.label ?? catalog.plugins.get(item.plugin)?.name ?? item.plugin;
}

/**
 * The wording a leaf falls back to, which the dialog shows as placeholders: the
 * page's own name and header lines, or a plugin's manifest.
 */
function leafDefaults(item: SidebarItem | null, catalog: Catalog) {
  if (!item || item.kind === "parent") return { name: "", scope: "", notes: "" };

  if (item.kind === "route") {
    const route = catalog.routes.get(item.route);
    return {
      name: route?.navLabel ?? "",
      scope: route?.scope ?? "",
      notes: route?.description ?? "",
    };
  }

  const plugin = catalog.plugins.get(item.plugin);
  return {
    name: plugin?.name ?? "",
    scope: plugin ? pluginTagline(plugin) : "",
    notes: plugin?.description ?? "",
  };
}

/** The icon an entry falls back to: the page's own, or a parent's default child's. */
function defaultIcon(item: SidebarItem, catalog: Catalog): AppRouteIcon {
  if (item.kind === "parent") {
    const child = item.children.find((entry) => entry.id === item.defaultChild) ?? item.children[0];
    return child ? defaultIcon(child, catalog) : Layers;
  }
  if (item.kind === "route") return catalog.routes.get(item.route)?.icon ?? Package;
  return Package;
}

/** The icon an entry is drawn with: the chosen one, else the fallback above. */
function iconOf(item: SidebarItem, catalog: Catalog): AppRouteIcon {
  return resolveIcon(item.icon, catalog.custom) ?? defaultIcon(item, catalog);
}

/**
 * Keeps a bad record from blanking the whole window: a frameless window whose
 * tree unmounts reads as "opened then vanished" rather than as a crash.
 */
class RenderGuard extends Component<
  { message: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("The sidebar manager failed to render:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex items-start gap-2 p-4 text-sm">
        <AlertTriangle className="text-destructive size-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <div className="text-destructive font-medium">{this.props.message}</div>
          <div className="text-muted-foreground font-mono text-xs break-all">{error.message}</div>
        </div>
      </div>
    );
  }
}

export default function SidebarManagerWindow() {
  const { t } = useAppTranslation();
  const { config } = useSidebarStore();

  return (
    <WindowFrame
      titleBar={<TitleBar title={t("sidebarManager.title")} showPin showMaximize />}
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      <RenderGuard message={t("sidebarManager.loadFailed")}>
        {config ? (
          <ManagerBody config={config} />
        ) : (
          <div className="space-y-3 p-4">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        )}
      </RenderGuard>
    </WindowFrame>
  );
}

function ManagerBody({ config }: { config: SidebarConfig }) {
  const { t } = useAppTranslation();
  const { plugins: packages } = usePluginsStore();
  const { byName: customIcons } = useCustomIcons();
  const { save } = useSidebarStore();

  const catalog = useMemo<Catalog>(
    () => ({
      routes: new Map(appRoutes.map((route) => [route.id, route])),
      plugins: new Map(packages.map((plugin) => [plugin.id, plugin])),
      custom: customIcons,
    }),
    [packages, customIcons]
  );

  const placed = useMemo(() => placedIds(config), [config]);
  const unplacedRoutes = useMemo(
    () => appRoutes.filter((route) => !placed.routes.has(route.id)),
    [placed]
  );
  const tabPlugins = useMemo(
    () => packages.filter((plugin) => sidebarReady(plugin) && !placed.plugins.has(plugin.id)),
    [packages, placed]
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [iconColor, setIconColor] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [notes, setNotes] = useState("");
  const [drag, setDrag] = useState<DragState>({ kind: null, preview: null });
  const cacheId = useId();

  const commit = useCallback(
    (mutate: (current: SidebarConfig) => SidebarConfig | null) => {
      const next = mutate(structuredClone(config));
      if (!next) return;
      void save(next).catch((error: unknown) => {
        console.error("Failed to save the sidebar layout:", error);
        toast.error(String(error));
      });
    },
    [config, save]
  );

  const handleDragStart = (event: DragStartEvent) => {
    setDrag({ kind: dragKindOf(config, String(event.active.id)), preview: null });
  };

  /** Mirrors `handleDragEnd`'s resolution so the markers match the real drop. */
  const handleDragOver = (event: DragOverEvent) => {
    const activeId = String(event.active.id);
    const kind = dragKindOf(config, activeId);
    const over = event.over;

    if (!kind || !over) {
      setDrag((state) => (state.preview ? { ...state, preview: null } : state));
      return;
    }

    const overId = String(over.id);

    if (kind === "group") {
      const groupId = groupOf(config, overId);
      const next: DropPreview | null = groupId
        ? { box: null, groupId, insertAt: 0, invalid: false, from: null }
        : null;
      setDrag((state) => (samePreview(state.preview, next) ? state : { kind, preview: next }));
      return;
    }

    const target = dropTarget(config, overId);
    if (!target) {
      setDrag((state) => (state.preview ? { ...state, preview: null } : state));
      return;
    }

    const items = boxItems(config, target.box) ?? [];
    const source = locate(config, activeId.slice(ITEM_SORT.length));
    // A marker in the box the entry already sits in would duplicate the gap
    // dnd-kit already holds open, so it is only drawn for a box it joins.
    const insertAt =
      source && source.box === target.box && source.index < target.index
        ? Math.min(target.index + 1, items.length)
        : Math.min(target.index, items.length);

    const next: DropPreview = {
      box: target.box,
      groupId: null,
      insertAt,
      invalid: kind === "parent" && target.box.startsWith("parent:"),
      from: source?.box ?? null,
    };
    setDrag((state) => (samePreview(state.preview, next) ? state : { kind, preview: next }));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDrag({ kind: null, preview: null });

    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    if (activeId.startsWith(GROUP_SORT)) {
      const from = config.groups.findIndex(
        (group) => group.id === activeId.slice(GROUP_SORT.length)
      );
      // A group dragged over an entry inside another group still means "move it
      // there", so the target group is resolved from whatever was hit.
      const overGroup = groupOf(config, overId);
      const to = overGroup ? config.groups.findIndex((group) => group.id === overGroup) : -1;
      if (from < 0 || to < 0 || from === to) return;

      commit((current) => {
        current.groups = arrayMove(current.groups, from, to);
        return current;
      });
      return;
    }

    if (!activeId.startsWith(ITEM_SORT)) return;
    const itemId = activeId.slice(ITEM_SORT.length);
    const target = dropTarget(config, overId);
    if (!target) return;

    const source = locate(config, itemId);
    if (source) {
      commit((current) => moveItem(current, itemId, target));
      return;
    }

    // Not in the layout: an entry dragged in from 其他 or from the pool.
    const leaf = leafFor(itemId, unplacedRoutes, tabPlugins);
    if (!leaf) return;
    commit((current) => insertLeaf(current, leaf, target));
  };

  const openNewGroup = () => {
    setText("");
    setIcon(null);
    setIconColor(null);
    setDraft({ mode: "newGroup" });
  };

  const openNewParent = (groupId: string) => {
    setText("");
    setIcon(null);
    setIconColor(null);
    setDraft({ mode: "newParent", groupId });
  };

  const openRenameGroup = (id: string, name: string) => {
    setText(name);
    setDraft({ mode: "renameGroup", id, name });
  };

  /** Any entry or parent: the dialog edits its name, icon, and header text. */
  const openEditItem = (id: string) => {
    const item = findItem(config, id);
    if (!item) return;

    // A field opens blank when nothing is saved, so the page's own wording stays
    // live: it shows as the placeholder, and an untouched field keeps it.
    setText(item.kind === "parent" ? item.name : (item.label ?? ""));
    setIcon(item.icon ?? null);
    setIconColor(item.iconColor ?? null);
    setScope(item.kind === "parent" ? "" : (item.scope ?? ""));
    setNotes(item.kind === "parent" ? "" : (item.notes ?? ""));
    setDraft({ mode: "editItem", id, parent: item.kind === "parent" });
  };

  const submitDraft = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;

    if (draft.mode === "deleteGroup") {
      commit((current) => {
        current.groups = current.groups.filter((group) => group.id !== draft.id);
        return current;
      });
      setDraft(null);
      return;
    }

    const name = text.trim();

    commit((current) => {
      if (draft.mode === "newGroup") {
        if (!name) return null;
        current.groups.push({ id: newId("group"), name, items: [] });
      } else if (draft.mode === "renameGroup") {
        if (!name) return null;
        const group = current.groups.find((item) => item.id === draft.id);
        if (!group) return null;
        group.name = name;
      } else if (draft.mode === "newParent") {
        if (!name) return null;
        const group = current.groups.find((item) => item.id === draft.groupId);
        if (!group) return null;
        group.items.push({
          kind: "parent",
          id: newId("parent"),
          name,
          icon: null,
          iconColor: null,
          defaultChild: null,
          children: [],
        });
      } else {
        const item = findItem(current, draft.id);
        if (!item) return null;

        if (item.kind === "parent") {
          if (!name) return null;
          item.name = name;
        } else {
          // An empty field is "no override", not a blank row or header line.
          item.label = name || null;
          item.scope = scope.trim() || null;
          item.notes = notes.trim() || null;
        }
        item.icon = icon;
        item.iconColor = iconColor;
      }
      return current;
    });

    setDraft(null);
  };

  const defaultChild = (parentId: string, childId: string) => {
    commit((current) => {
      const parent = findParent(current, parentId);
      if (!parent) return null;
      parent.defaultChild = childId;
      return current;
    });
  };

  const removeParent = (parentId: string) => {
    commit((current) => {
      for (const group of current.groups) {
        const index = group.items.findIndex(
          (item) => item.kind === "parent" && item.id === parentId
        );
        if (index < 0) continue;

        const parent = group.items[index];
        if (parent.kind !== "parent") continue;

        // The children stay where the menu was, rather than vanishing with it.
        group.items.splice(index, 1, ...parent.children);
        return normalizeDefaults(current);
      }
      return null;
    });
  };

  const editedItem = draft?.mode === "editItem" ? findItem(config, draft.id) : null;
  const iconFallback = editedItem ? defaultIcon(editedItem, catalog) : Package;
  const defaults = leafDefaults(editedItem, catalog);
  // A parent needs a name; a leaf's name is an override and may be cleared.
  const requiresName =
    draft !== null && draft.mode !== "deleteGroup" && (draft.mode !== "editItem" || draft.parent);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border shrink-0 space-y-1 border-b px-4 py-3">
        <p className="text-muted-foreground text-xs">{t("sidebarManager.description")}</p>
        <p className="text-muted-foreground text-xs">{t("sidebarManager.help")}</p>
        <div className="flex items-center justify-between gap-3 pt-2">
          <div className="min-w-0">
            <Label htmlFor={cacheId} className="text-sm font-medium">
              {t("sidebarManager.cachePages")}
            </Label>
            <p className="text-muted-foreground text-xs">{t("sidebarManager.cachePagesHint")}</p>
          </div>
          <Switch
            id={cacheId}
            checked={config.cachePages ?? false}
            onCheckedChange={(checked) =>
              commit((current) => {
                current.cachePages = checked;
                return current;
              })
            }
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={openNewGroup}>
            <Plus className="size-3.5" />
            {t("sidebarManager.addGroup")}
          </Button>
          <span className="text-muted-foreground ml-auto text-xs">
            {t("sidebarManager.groupCount", { n: config.groups.length })}
          </span>
        </div>

        <DndContext
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDrag({ kind: null, preview: null })}
        >
          <DragStateContext.Provider value={drag}>
            <SortableContext
              items={config.groups.map((group) => sortGroupId(group.id))}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-3">
                {config.groups.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    catalog={catalog}
                    onRename={(name) => openRenameGroup(group.id, name)}
                    onDelete={() =>
                      setDraft({ mode: "deleteGroup", id: group.id, name: group.name })
                    }
                    onAddParent={() => openNewParent(group.id)}
                    onEdit={openEditItem}
                    onRemoveParent={removeParent}
                    onDefaultChild={defaultChild}
                  />
                ))}
              </div>
            </SortableContext>

            <div className="mt-3 space-y-3">
              <OutsideCard
                box={OTHER_BOX}
                title={t("sidebarManager.other")}
                hint={t("sidebarManager.otherHint")}
                empty={t("sidebarManager.otherEmpty")}
              >
                {unplacedRoutes.map((route) => (
                  <DraggableRow
                    key={routeItemId(route.id)}
                    id={routeItemId(route.id)}
                    label={route.navLabel}
                    icon={route.icon}
                  />
                ))}
              </OutsideCard>

              <OutsideCard
                box={POOL_BOX}
                title={t("sidebarManager.pool")}
                hint={t("sidebarManager.poolHint")}
                empty={t("sidebarManager.poolEmpty")}
              >
                {tabPlugins.map((plugin) => (
                  <DraggableRow
                    key={pluginItemId(plugin.id)}
                    id={pluginItemId(plugin.id)}
                    label={plugin.name}
                    icon={Package}
                  />
                ))}
              </OutsideCard>
            </div>
          </DragStateContext.Provider>
        </DndContext>
      </div>

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-h-[calc(100vh-3rem)] overflow-y-auto">
          <form onSubmit={submitDraft} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{draftTitle(draft, t)}</DialogTitle>
              {draft?.mode === "deleteGroup" && (
                <DialogDescription>
                  {t("sidebarManager.deleteGroupConfirm", { name: draft.name })}
                </DialogDescription>
              )}
            </DialogHeader>

            {draft?.mode !== "deleteGroup" && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sidebar-entry-name">{t("sidebarManager.name")}</Label>
                  <Input
                    id="sidebar-entry-name"
                    autoFocus
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    placeholder={defaults.name || t("sidebarManager.namePlaceholder")}
                  />
                  {draft?.mode === "editItem" && !draft.parent && (
                    <p className="text-muted-foreground text-xs">
                      {t("sidebarManager.nameDefault")}
                    </p>
                  )}
                </div>

                {draft?.mode === "editItem" && (
                  <div className="space-y-1.5">
                    <Label>{t("sidebarManager.icon")}</Label>
                    <IconPicker
                      value={icon}
                      color={iconColor}
                      onChange={setIcon}
                      onColorChange={setIconColor}
                      fallback={iconFallback}
                    />
                  </div>
                )}

                {draft?.mode === "editItem" && !draft.parent && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="sidebar-entry-scope">{t("sidebarManager.scope")}</Label>
                      <Input
                        id="sidebar-entry-scope"
                        value={scope}
                        onChange={(event) => setScope(event.target.value)}
                        placeholder={defaults.scope}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="sidebar-entry-notes">{t("sidebarManager.notes")}</Label>
                      <Textarea
                        id="sidebar-entry-notes"
                        rows={5}
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                        placeholder={defaults.notes}
                      />
                      <p className="text-muted-foreground text-xs">
                        {t("sidebarManager.pageDefaultHint")}
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                {t("sidebarManager.cancel")}
              </Button>
              {draft?.mode === "deleteGroup" ? (
                <Button type="submit" variant="destructive">
                  {t("sidebarManager.deleteGroup")}
                </Button>
              ) : (
                <Button type="submit" disabled={requiresName && text.trim().length === 0}>
                  {t("sidebarManager.save")}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function draftTitle(draft: Draft | null, t: (key: string) => string): string {
  if (!draft) return "";
  switch (draft.mode) {
    case "newGroup":
      return t("sidebarManager.addGroup");
    case "renameGroup":
      return t("sidebarManager.renameGroup");
    case "deleteGroup":
      return t("sidebarManager.deleteGroup");
    case "newParent":
      return t("sidebarManager.addParent");
    case "editItem":
      return t("sidebarManager.editTitle");
  }
}

function findParent(config: SidebarConfig, id: string) {
  for (const group of config.groups) {
    const parent = group.items.find((item) => item.kind === "parent" && item.id === id);
    if (parent && parent.kind === "parent") return parent;
  }
  return null;
}

/** An entry anywhere in the layout, a parent's children included. */
function findItem(config: SidebarConfig, id: string): SidebarItem | null {
  for (const group of config.groups) {
    for (const item of group.items) {
      if (item.id === id) return item;
      if (item.kind !== "parent") continue;
      const child = item.children.find((entry) => entry.id === id);
      if (child) return child;
    }
  }
  return null;
}

/** The entry an id stands for, when it is not in the layout yet. */
function leafFor(
  itemId: string,
  unplacedRoutes: AppRoute[],
  tabPlugins: PluginView[]
): SidebarLeafItem | null {
  const [kind, ...rest] = itemId.split(":");
  const ref = rest.join(":");

  if (kind === "route" && unplacedRoutes.some((route) => route.id === ref)) {
    return { kind: "route", id: itemId, route: ref };
  }
  if (kind === "plugin" && tabPlugins.some((plugin) => plugin.id === ref)) {
    return { kind: "plugin", id: itemId, plugin: ref };
  }
  return null;
}

/** One group: draggable as a whole, and a drop target for its own entries. */
function GroupCard({
  group,
  catalog,
  onRename,
  onDelete,
  onAddParent,
  onEdit,
  onRemoveParent,
  onDefaultChild,
}: {
  group: SidebarConfig["groups"][number];
  catalog: Catalog;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddParent: () => void;
  onEdit: (id: string) => void;
  onRemoveParent: (id: string) => void;
  onDefaultChild: (parentId: string, childId: string) => void;
}) {
  const { t } = useAppTranslation();
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id: sortGroupId(group.id),
  });
  const { setNodeRef: setHeadRef } = useDroppable({ id: boxId(headBox(group.id)) });
  const { preview } = useContext(DragStateContext);

  const box = groupBox(group.id);
  const isHeadTarget = preview?.box === headBox(group.id);
  const isBoxTarget = preview?.box === box;
  const isReorderTarget = preview?.groupId === group.id;
  // The title row always draws the line, even for an entry already in the
  // group: the sortable gap only ever opens where that entry is now.
  const showLine = Boolean(isHeadTarget || (isBoxTarget && preview?.from !== box));

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "bg-card rounded-lg border",
        isDragging && "opacity-60",
        isReorderTarget && "outline-primary outline-1 outline-dashed"
      )}
    >
      <div
        ref={setHeadRef}
        className={cn(
          "border-border flex items-center gap-1 border-b px-2 py-1.5",
          isHeadTarget && "bg-primary/5 outline-primary outline-1 outline-dashed"
        )}
      >
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground cursor-grab touch-none rounded p-0.5 active:cursor-grabbing"
          aria-label={t("sidebarManager.dragGroup")}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
        <span className="truncate text-sm font-medium">{group.name}</span>
        <span className="bg-secondary text-secondary-foreground rounded-full px-1.5 text-xs">
          {group.items.length}
        </span>
        <div className="ml-auto flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("sidebarManager.renameGroup")}
            onClick={() => onRename(group.name)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("sidebarManager.deleteGroup")}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <SortableContext
        items={group.items.map((item) => sortItemId(item.id))}
        strategy={verticalListSortingStrategy}
      >
        <div
          className={cn(
            "min-h-10 space-y-1 p-1.5",
            isBoxTarget && "bg-primary/5 outline-primary outline-1 outline-dashed"
          )}
        >
          {group.items.length === 0 && (
            <p className="text-muted-foreground px-1 py-1 text-xs">
              {t("sidebarManager.emptyGroup")}
            </p>
          )}
          {group.items.map((item, index) => (
            <Fragment key={item.id}>
              <DropLine visible={showLine && preview?.insertAt === index} />
              {item.kind === "parent" ? (
                <ParentCard
                  parent={item}
                  catalog={catalog}
                  onEdit={onEdit}
                  onDelete={() => onRemoveParent(item.id)}
                  onDefaultChild={(childId) => onDefaultChild(item.id, childId)}
                />
              ) : (
                <ItemRow item={item} catalog={catalog} onEdit={() => onEdit(item.id)} />
              )}
            </Fragment>
          ))}
          <DropLine visible={showLine && (preview?.insertAt ?? 0) >= group.items.length} />
        </div>
      </SortableContext>

      <div className="border-border border-t px-2 py-1">
        <Button type="button" variant="ghost" size="sm" onClick={onAddParent}>
          <Plus className="size-3.5" />
          {t("sidebarManager.addParent")}
        </Button>
      </div>
    </div>
  );
}

/** A first-level entry that holds the second level. */
function ParentCard({
  parent,
  catalog,
  onEdit,
  onDelete,
  onDefaultChild,
}: {
  parent: Extract<SidebarItem, { kind: "parent" }>;
  catalog: Catalog;
  onEdit: (id: string) => void;
  onDelete: () => void;
  onDefaultChild: (childId: string) => void;
}) {
  const { t } = useAppTranslation();
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id: sortItemId(parent.id),
  });
  const { setNodeRef: setDropRef } = useDroppable({ id: boxId(parentBox(parent.id)) });
  const { kind, preview } = useContext(DragStateContext);
  const Icon = iconOf(parent, catalog);

  const box = parentBox(parent.id);
  const isTarget = preview?.box === box;
  // A parent cannot become a second-level entry, so every parent's inside is
  // marked as refusing one while a parent is what is being dragged.
  const refusesParents = kind === "parent";
  const showLine = isTarget && !preview?.invalid && preview?.from !== box;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("bg-background rounded-md border", isDragging && "opacity-60")}
    >
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground cursor-grab touch-none rounded p-0.5 active:cursor-grabbing"
          aria-label={t("sidebarManager.dragParent")}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
        {createElement(Icon, {
          className: "text-muted-foreground size-3.5 shrink-0",
          style: parent.iconColor ? { color: parent.iconColor } : undefined,
        })}
        <span className="truncate text-sm font-medium">{parent.name}</span>
        <div className="ml-auto flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("sidebarManager.edit")}
            onClick={() => onEdit(parent.id)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("sidebarManager.deleteParent")}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div
        ref={setDropRef}
        className={cn(
          "border-border min-h-10 border-t p-1.5",
          refusesParents
            ? isTarget
              ? "bg-destructive/5 outline-destructive outline-1 outline-dashed"
              : "outline-destructive/40 outline-1 outline-dashed"
            : isTarget && "bg-primary/5 outline-primary outline-1 outline-dashed"
        )}
      >
        <SortableContext
          items={parent.children.map((child) => sortItemId(child.id))}
          strategy={verticalListSortingStrategy}
        >
          <RadioGroup
            value={parent.defaultChild ?? ""}
            onValueChange={onDefaultChild}
            className="gap-1"
          >
            {parent.children.length === 0 && (
              <p className="text-muted-foreground px-1 py-1 text-xs">
                {t("sidebarManager.emptyParent")}
              </p>
            )}
            {parent.children.map((child, index) => (
              <Fragment key={child.id}>
                <DropLine visible={showLine && preview?.insertAt === index} />
                <ChildRow child={child} catalog={catalog} onEdit={() => onEdit(child.id)} />
              </Fragment>
            ))}
            <DropLine visible={showLine && (preview?.insertAt ?? 0) >= parent.children.length} />
          </RadioGroup>
        </SortableContext>
      </div>
    </div>
  );
}

/** A second-level entry: draggable, and selectable as the parent's default. */
function ChildRow({
  child,
  catalog,
  onEdit,
}: {
  child: SidebarLeafItem;
  catalog: Catalog;
  onEdit: () => void;
}) {
  const { t } = useAppTranslation();
  const radioId = useId();
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id: sortItemId(child.id),
  });
  const Icon = iconOf(child, catalog);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "bg-card flex items-center gap-2 rounded-md border px-2 py-1",
        isDragging && "opacity-60"
      )}
    >
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground cursor-grab touch-none rounded p-0.5 active:cursor-grabbing"
        aria-label={t("sidebarManager.dragEntry")}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      {createElement(Icon, {
        className: "text-muted-foreground size-3.5 shrink-0",
        style: child.iconColor ? { color: child.iconColor } : undefined,
      })}
      <span className="truncate text-sm">{labelOf(child, catalog)}</span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <RadioGroupItem value={child.id} id={radioId} title={t("sidebarManager.defaultHint")} />
        <Label htmlFor={radioId} className="text-muted-foreground text-xs font-normal">
          {t("sidebarManager.defaultChild")}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("sidebarManager.edit")}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      </div>
    </div>
  );
}

/** A first-level entry that is a page of its own. */
function ItemRow({
  item,
  catalog,
  onEdit,
}: {
  item: SidebarLeafItem;
  catalog: Catalog;
  onEdit: () => void;
}) {
  const { t } = useAppTranslation();
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id: sortItemId(item.id),
  });
  const Icon = iconOf(item, catalog);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "bg-background flex items-center gap-2 rounded-md border px-2 py-1.5",
        isDragging && "opacity-60"
      )}
    >
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground cursor-grab touch-none rounded p-0.5 active:cursor-grabbing"
        aria-label={t("sidebarManager.dragEntry")}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      {createElement(Icon, {
        className: "text-muted-foreground size-3.5 shrink-0",
        style: item.iconColor ? { color: item.iconColor } : undefined,
      })}
      <span className="truncate text-sm">{labelOf(item, catalog)}</span>
      <div className="ml-auto flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("sidebarManager.edit")}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      </div>
    </div>
  );
}

/** A row that is not in the layout: drag it into a group to place it. */
function DraggableRow({
  id,
  label,
  icon: Icon,
}: {
  id: string;
  label: string;
  icon: AppRouteIcon;
}) {
  const { setNodeRef, transform, attributes, listeners, isDragging } = useDraggable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "bg-background flex items-center gap-2 rounded-md border border-dashed px-2 py-1.5",
        isDragging && "opacity-60"
      )}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="text-muted-foreground size-3.5 shrink-0" />
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="truncate text-sm">{label}</span>
    </div>
  );
}

/**
 * One of the two lists outside the layout.
 *
 * Dropping an entry here removes it from the layout: a page falls back into
 * 其他, a plugin goes back to the plugins page's tabs.
 */
function OutsideCard({
  box,
  title,
  hint,
  empty,
  children,
}: {
  box: string;
  title: string;
  hint: string;
  empty: string;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: boxId(box) });
  const { preview } = useContext(DragStateContext);
  const isTarget = preview?.box === box;
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "bg-card rounded-lg border border-dashed",
        isTarget && "bg-primary/5 outline-primary outline-1 outline-dashed"
      )}
    >
      <div className="border-border flex items-center gap-2 border-b border-dashed px-3 py-1.5">
        <span className="text-muted-foreground text-sm font-medium">{title}</span>
        <span className="text-muted-foreground ml-auto text-xs">{hint}</span>
      </div>
      <div className="min-h-10 space-y-1 p-1.5">
        {hasChildren ? (
          children
        ) : (
          <p className="text-muted-foreground px-1 py-1 text-xs">{empty}</p>
        )}
        <DropLine visible={isTarget} />
      </div>
    </div>
  );
}

/** The marker showing where the dragged entry would land. */
function DropLine({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return <div aria-hidden className="border-primary mx-1 border-t-2 border-dashed" />;
}

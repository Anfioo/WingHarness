/**
 * Chinese for codelet's own chrome.
 *
 * codelet ships every label as an English literal baked into its bundle and its
 * extension API has no hook for replacing one — the workbench takes no locale,
 * and there is no message catalogue to load. So a translated workbench is
 * assembled from outside the package, the two ways it leaves open:
 *
 * - `localizeExtensions` clones the built-in extensions with translated
 *   manifests. A manifest is data: the activity bar, the view headers and the
 *   command palette read the copy, and nothing has to know it was rewritten.
 * - `createDomTranslator` watches the mounted shell and rewrites the strings
 *   the shell draws itself — menus, placeholders, the status bar — which no
 *   extension contributes and so no manifest can reach.
 *
 * Two places are deliberately left in English: the document showing, because
 * codelet renders it into CodeMirror and a line reading `Search` is the file's
 * own text; and the file tree, because a row's label is a file's name. Anything
 * a reader could have typed is not chrome.
 *
 * Webview views (the Extensions list, the Markdown preview) draw into an
 * iframe, out of reach of both: their frame stays English.
 */

/** One English literal and the Chinese that replaces it, both whole strings. */
export interface CodeletStrings {
  /** Matched against a label's whole, trimmed text. */
  dictionary: Record<string, string>;
  /** Labels the shell builds around a value: `Close x`, `3 lines`, `Ln 1, Col 2`. */
  composites: readonly (readonly [RegExp, (...parts: string[]) => string])[];
}

/**
 * The shell's own English, as the bundle spells it.
 *
 * Only what a reader sees: the class names, key hints, MIME types and error
 * codes that share the same string tables are left alone.
 */
const CHINESE: CodeletStrings = {
  dictionary: {
    // Activity bar, side bar and panel headings.
    Explorer: "资源管理器",
    Search: "搜索",
    Extensions: "扩展",
    Problems: "问题",
    Files: "文件",
    "Text Editor": "文本编辑器",
    "Binary File": "二进制文件",
    Theme: "主题",

    // Explorer and tree row actions.
    "New File": "新建文件",
    Rename: "重命名",
    Delete: "删除",
    Copy: "复制",
    Cut: "剪切",
    Paste: "粘贴",
    "Copy Path": "复制路径",
    "Copy Relative Path": "复制相对路径",
    Download: "下载",
    "Filter Files": "筛选文件",
    Open: "打开",
    "Open Anyway": "仍然打开",
    "Adding files": "正在添加文件",
    Copied: "已复制",

    // Tabs, menus and panels.
    Close: "关闭",
    "Close Others": "关闭其他",
    "Close Editor": "关闭编辑器",
    "Close All Editors": "关闭全部编辑器",
    "Close to the Right": "关闭右侧",
    "Close Panel": "关闭面板",
    "Close Secondary Side Bar": "关闭次要侧边栏",
    "Toggle Sidebar": "切换侧边栏",
    "Toggle Panel": "切换面板",
    "Toggle Secondary Side Bar": "切换次要侧边栏",
    "Resize sidebar": "调整侧边栏宽度",
    "Resize panel": "调整面板高度",
    "Resize secondary side bar": "调整次要侧边栏宽度",
    "Nothing is showing this tab.": "没有视图正在显示此标签页。",

    // Reaching a file, a command, a setting.
    "Open a file": "打开文件",
    "Run a command": "运行命令",
    "Go to file — type > for commands": "转到文件 — 输入 > 运行命令",
    "No matching commands": "没有匹配的命令",
    "No matching files": "没有匹配的文件",
    "No matching items": "没有匹配的项",
    "Select an item": "选择一项",
    "Select Color Theme": "选择颜色主题",
    "Preferences: Color Theme": "首选项：颜色主题",
    "Select Language Mode": "选择语言模式",
    "Change Language Mode": "更改语言模式",
    "Select editor for this file": "为此文件选择编辑器",
    "Auto Detect": "自动检测",

    // Saving and confirming.
    Save: "保存",
    "Don't Save": "不保存",
    Cancel: "取消",
    OK: "确定",
    Skip: "跳过",
    "This cannot be undone.": "此操作无法撤销。",
    "Everything in the folder goes with it, and none of it can be brought back.":
      "文件夹中的所有内容都会一并删除，且无法恢复。",
    "What they hold now cannot be brought back.": "当前内容将无法恢复。",
    "Skipping keeps what the workspace holds and writes the rest.":
      "跳过会保留工作区中的内容，并写入其余部分。",
    "Your changes will be lost if you don't save them.": "如果不保存，你的更改将会丢失。",
    "One of the files dropped was not added.": "拖入的文件中有一个未能添加。",

    // Status bar.
    "Read-only": "只读",
    "No problems have been detected in the workspace.": "工作区内未检测到问题。",
    Ln: "行",
    ", Col": "，列",

    // The remote extension, which the project page loads.
    remote: "远程",
    Reconnect: "重新连接",
    Sync: "同步",

    // The markdown preview extension.
    "Open Preview": "打开预览",
    "Open Source": "打开源代码",

    // The extensions view's welcome text.
    "No extensions to show.\n\nEverything this workbench was given is listed here, with what it contributes under it and a button to stop it.":
      "没有可显示的扩展。\n\n此工作台收到的每个扩展都会列在这里，其下方是它贡献的内容，以及一个停用按钮。",

    // Language labels the status bar shows, where codelet spells them out.
    "Plain Text": "纯文本",
    Assembly: "汇编",
    "JSON with Comments": "带注释的 JSON",
    "Shell Script": "Shell 脚本",
  },
  composites: [
    [/^(\d+) line$/, (n) => `${n} 行`],
    [/^(\d+) lines$/, (n) => `${n} 行`],
    [/^More actions for (.+)$/, (name) => `${name} 的更多操作`],
    [/^Rename (.+)$/, (name) => `重命名 ${name}`],
    [/^Close (.+)$/, (name) => `关闭 ${name}`],
    [/^Preview (.+)$/, (name) => `预览 ${name}`],
    [/^Panel: (.+)$/, (name) => `面板：${name}`],
    [/^Secondary Side Bar: (.+)$/, (name) => `次要侧边栏：${name}`],
    [/^Syncing (.+)$/, (name) => `正在同步 ${name}`],
    [/^and (\d+) more$/, (count) => `以及其他 ${count} 项`],
    [/^(\d+) running$/, (count) => `${count} 个运行中`],
    [
      /^(\d+) error(?:s)?, (\d+) warning(?:s)?$/,
      (errors, warnings) => `${errors} 个错误，${warnings} 个警告`,
    ],
    [/^(.+) \(read-only\)$/, (name) => `${name}（只读）`],
    [
      /^Nothing is showing this file: (.+) is not running\.$/,
      (name) => `没有视图在显示此文件：${name} 未运行。`,
    ],
  ],
};

/**
 * The strings for a language, or nothing when the shell's English is already
 * what the reader wants.
 */
export function codeletStrings(language: string): CodeletStrings | null {
  return language.toLowerCase().startsWith("zh") ? CHINESE : null;
}

/** One label, or nothing when it is not one this knows. */
export function translate(strings: CodeletStrings, label: string): string | null {
  const exact = strings.dictionary[label];
  if (exact !== undefined) return exact;
  for (const [pattern, render] of strings.composites) {
    const match = label.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return null;
}

/**
 * The manifest fields carrying text a reader sees. Everything else — ids,
 * icons, `when` clauses — is copied through untouched, so an extension's own
 * lookup of its contributions still lands.
 */
interface LocalizableManifest {
  contributes?: {
    viewsContainers?: Record<string, readonly { title: string }[]>;
    views?: Record<string, readonly { name: string; filter?: { placeholder?: string } }[]>;
    viewsWelcome?: readonly { contents: string }[];
    commands?: readonly { title: string; category?: string }[];
  };
}

/**
 * The built-in extensions with their manifest text translated.
 *
 * A clone rather than an edit: the modules export singletons shared with any
 * other workbench on the page, so their manifests are never written to. The
 * `activate` half is reused as is, and it reads only ids, which the rewrite
 * leaves alone.
 *
 * With nothing to translate the list is handed back as it came, which is what
 * keeps the English page free of copies.
 */
export function localizeExtensions<T extends object>(
  extensions: readonly T[],
  strings: CodeletStrings | null
): T[] {
  if (!strings) return [...extensions];
  return extensions.map((extension) => {
    const manifest = (extension as { manifest?: LocalizableManifest }).manifest;
    if (!manifest?.contributes) return extension;
    return {
      ...extension,
      manifest: { ...manifest, contributes: translateManifest(manifest.contributes, strings) },
    };
  });
}

function translateManifest(
  contributes: NonNullable<LocalizableManifest["contributes"]>,
  strings: CodeletStrings
): NonNullable<LocalizableManifest["contributes"]> {
  const text = (value: string) => translate(strings, value) ?? value;
  return {
    ...contributes,
    viewsContainers: contributes.viewsContainers
      ? Object.fromEntries(
          Object.entries(contributes.viewsContainers).map(([place, containers]) => [
            place,
            containers.map((container) => ({ ...container, title: text(container.title) })),
          ])
        )
      : undefined,
    views: contributes.views
      ? Object.fromEntries(
          Object.entries(contributes.views).map(([container, views]) => [
            container,
            views.map((view) => ({
              ...view,
              name: text(view.name),
              filter: view.filter?.placeholder
                ? { ...view.filter, placeholder: text(view.filter.placeholder) }
                : view.filter,
            })),
          ])
        )
      : undefined,
    viewsWelcome: contributes.viewsWelcome?.map((welcome) => ({
      ...welcome,
      contents: text(welcome.contents),
    })),
    commands: contributes.commands?.map((command) => ({
      ...command,
      title: text(command.title),
      category: command.category === undefined ? undefined : text(command.category),
    })),
  };
}

/**
 * The subtrees no translation may touch: the document showing, whose text is
 * the file's own, and a tree row, whose label is a file's name.
 *
 * `.cm-content` rather than `.cm-editor`, so the editor's own tooltips and
 * context menu — drawn beside the content, not in it — stay reachable.
 */
const OPAQUE = ".cm-content, .cl-row";

function translatable(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return !element?.closest(OPAQUE);
}

function translateTextNode(strings: CodeletStrings, node: Text): void {
  if (!translatable(node) || !node.data.trim()) return;
  const label = node.data.trim();
  const translated = translate(strings, label);
  if (translated === null) return;
  // The whitespace around a label is the shell's spacing, not part of it; the
  // replacement goes where the label was, so ` lines` becomes ` 行`.
  node.data = node.data.replace(label, () => translated);
}

function translateAttributes(strings: CodeletStrings, element: Element): void {
  if (!translatable(element)) return;
  for (const name of ["title", "aria-label", "placeholder"]) {
    const value = element.getAttribute(name);
    if (value === null || !value.trim()) continue;
    const translated = translate(strings, value.trim());
    if (translated !== null) element.setAttribute(name, translated);
  }
}

function translateSubtree(strings: CodeletStrings, root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(strings, root as Text);
    return;
  }
  if (!(root instanceof Element)) return;
  translateAttributes(strings, root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(strings, node as Text);
    else translateAttributes(strings, node as Element);
  }
}

/**
 * Rewrites the shell's chrome as it is drawn.
 *
 * A `MutationObserver` over the mounted host, because the shell re-renders
 * freely: a menu opened, a tab renamed, the line count ticking. Exact labels
 * are replaced whole — matching a substring would put Chinese inside an English
 * sentence — and a label already translated matches nothing, so a rewrite never
 * feeds itself.
 *
 * The observer also fires for every keystroke inside the editor it is watching
 * over, so the opaque check runs before anything else and the document's own
 * mutations cost one `closest()` and stop.
 */
export function createDomTranslator(
  host: HTMLElement,
  strings: CodeletStrings
): { dispose: () => void } {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (!translatable(record.target)) continue;
      if (record.type === "characterData") {
        translateTextNode(strings, record.target as Text);
      } else if (record.type === "attributes") {
        translateAttributes(strings, record.target as Element);
      } else {
        record.addedNodes.forEach((node) => translateSubtree(strings, node));
      }
    }
  });
  observer.observe(host, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["title", "aria-label", "placeholder"],
  });

  translateSubtree(strings, host);
  return { dispose: () => observer.disconnect() };
}

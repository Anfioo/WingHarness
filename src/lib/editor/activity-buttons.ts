// The activity-bar buttons this app owns, drawn inside codelet's own bar.
//
// codelet renders one activity bar from its `viewsContainers` contributions and
// has no Git or database glyph in its closed icon set. So a feature contributes
// a container for real — that is what puts the button among the others, with
// the same 48px chrome — then swaps the icon, intercepts the click before
// codelet's delegated handler can reveal an empty side bar, and marks the
// button while its view is showing.
//
// Both the Git buttons and the project database button are this, so it lives
// here rather than once per extension.

/** Lucide's `database`, in the stroke shape codelet's own icons are drawn in. */
export const DATABASE_ICON = [
  '<ellipse cx="12" cy="5" rx="9" ry="3"/>',
  '<path d="M3 5v14a9 3 0 0 0 18 0V5"/>',
  '<path d="M3 12a9 3 0 0 0 18 0"/>',
].join("");

export interface ActivityButtonSpec {
  /** The label codelet gives the contributed container's button. */
  label: string;
  /** Inner SVG markup. */
  icon: string;
  /** Whether the view this button opens is showing. */
  isActive(): boolean;
  /** What a click does; codelet's own handler has already been stopped. */
  onActivate(): void;
}

export interface ActivityButtonsOptions {
  /** The element the workbench was mounted into; the activity bar lives inside it. */
  parent: HTMLElement;
  buttons: ActivityButtonSpec[];
  /**
   * Called for a click on an activity button that is not one of `buttons`, so
   * the caller can put its own view away. This is what makes two extensions'
   * buttons mutually exclusive without either knowing about the other.
   */
  onOtherClick?(): void;
  /** A store subscription, so the active styling follows state changes. */
  subscribe?(listener: () => void): () => void;
}

export interface ActivityButtonsHandle {
  /** Drops every listener and observer. */
  dispose(): void;
  /** Re-finds, re-paints and re-marks the buttons. */
  refresh(): void;
}

/** Marks a button whose view is showing; `index.css` styles the attribute. */
const ACTIVE_ATTRIBUTE = "data-app-active";
/** Records the icon already painted, so a re-render is not repainted every frame. */
const ICON_ATTRIBUTE = "data-app-icon";

interface Attached {
  element: HTMLButtonElement;
  spec: ActivityButtonSpec;
  onClick: (event: MouseEvent) => void;
}

export function attachActivityButtons(options: ActivityButtonsOptions): ActivityButtonsHandle {
  const { parent, buttons, onOtherClick } = options;
  const attached: Attached[] = [];

  const findButton = (label: string) =>
    Array.from(parent.querySelectorAll<HTMLButtonElement>("button.cl-activity-item")).find(
      (candidate) => candidate.getAttribute("aria-label") === label
    ) ?? null;

  const paintIcon = (element: HTMLButtonElement, icon: string) => {
    const svg = element.querySelector("svg");
    if (!svg) return;
    if (svg.getAttribute(ICON_ATTRIBUTE) === icon) return;
    svg.innerHTML = icon;
    svg.setAttribute(ICON_ATTRIBUTE, icon);
  };

  /** Capture on the button: codelet's own handler is delegated at the root. */
  const intercept = (action: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  const attach = (spec: ActivityButtonSpec): void => {
    const element = findButton(spec.label);
    if (!element) return;
    const existing = attached.find((entry) => entry.spec.label === spec.label);
    if (existing?.element === element) {
      paintIcon(element, spec.icon);
      return;
    }
    if (existing) existing.element.removeEventListener("click", existing.onClick, true);
    const onClick = intercept(spec.onActivate);
    element.addEventListener("click", onClick, true);
    paintIcon(element, spec.icon);
    const entry: Attached = { element, spec, onClick };
    if (existing) attached[attached.indexOf(existing)] = entry;
    else attached.push(entry);
  };

  const refresh = (): void => {
    // A re-render can replace the buttons; drop the dead listeners.
    for (let index = attached.length - 1; index >= 0; index -= 1) {
      const entry = attached[index];
      if (entry.element.isConnected) continue;
      entry.element.removeEventListener("click", entry.onClick, true);
      attached.splice(index, 1);
    }
    for (const spec of buttons) attach(spec);
    for (const entry of attached) {
      if (entry.spec.isActive()) entry.element.setAttribute(ACTIVE_ATTRIBUTE, "");
      else entry.element.removeAttribute(ACTIVE_ATTRIBUTE);
    }
  };

  const handleOther = (event: MouseEvent) => {
    if (!onOtherClick) return;
    const element = event.target instanceof Element ? event.target.closest("button") : null;
    if (!element?.classList.contains("cl-activity-item")) return;
    if (attached.some((entry) => entry.element === element)) return;
    onOtherClick();
  };

  if (onOtherClick) parent.addEventListener("click", handleOther, true);

  const observer = new MutationObserver(refresh);
  observer.observe(parent, { childList: true, subtree: true });
  const unsubscribe = options.subscribe?.(refresh) ?? null;
  refresh();

  return {
    dispose() {
      observer.disconnect();
      unsubscribe?.();
      if (onOtherClick) parent.removeEventListener("click", handleOther, true);
      for (const entry of attached) {
        entry.element.removeEventListener("click", entry.onClick, true);
      }
      attached.length = 0;
    },
    refresh,
  };
}

/**
 * The shortcut strings the settings page stores.
 *
 * Two forms live in one string field:
 *
 * - a plain combination like `Ctrl+Shift+A` or `Super+A` — the format the
 *   global-shortcut plugin registers, and the one an in-app listener can match;
 * - `preset:<id>`, for triggers that are not combinations at all — a bare
 *   Space, two Ctrl presses in a row — and so cannot travel through the OS
 *   registration API.
 *
 * A preset may also stand for an ordinary combination the picker should offer
 * with one click; `ctrlW` is one, and is stored as `Ctrl+W` so the OS can
 * register it.
 *
 * Keeping both in one string means a setting has one persisted value, whichever
 * kind of trigger it currently holds.
 */

/** A modifier the picker can set. `Super` is the Windows key. */
export type ShortcutModifier = "Ctrl" | "Shift" | "Alt" | "Super";

/** In this order, which is also how a recorded combination is written out. */
export const SHORTCUT_MODIFIERS: readonly ShortcutModifier[] = ["Ctrl", "Shift", "Alt", "Super"];

/** The picker stops at two modifiers on purpose — three is hard to press. */
export const MAX_SHORTCUT_MODIFIERS = 2;

/**
 * Triggers offered as presets. Most cannot be expressed as a combination;
 * `ctrlW` can, and exists so a setting can offer it with one click.
 */
export type ShortcutPresetId = "space" | "doubleCtrl" | "altSpace" | "winSpace" | "ctrlW";

export function isShortcutPresetId(value: string): value is ShortcutPresetId {
  return (
    value === "space" ||
    value === "doubleCtrl" ||
    value === "altSpace" ||
    value === "winSpace" ||
    value === "ctrlW"
  );
}

/** How long two Ctrl presses may be apart and still count as a double press. */
export const DOUBLE_PRESS_WINDOW_MS = 400;

const PRESET_PREFIX = "preset:";

/**
 * The stored form of a preset. A preset that is also a combination is stored as
 * that combination, so an OS-registered setting can hold it.
 */
export function presetSpec(id: ShortcutPresetId): string {
  if (id === "ctrlW") return "Ctrl+W";
  return `${PRESET_PREFIX}${id}`;
}

/** The preset a stored string names, or null when it is a combination. */
export function presetOf(spec: string): ShortcutPresetId | null {
  if (!spec.startsWith(PRESET_PREFIX)) return null;
  const id = spec.slice(PRESET_PREFIX.length);
  return isShortcutPresetId(id) ? id : null;
}

export type ComboSpec = {
  modifiers: ShortcutModifier[];
  key: string;
};

function modifierOf(token: string): ShortcutModifier | null {
  switch (token.toLowerCase()) {
    case "ctrl":
    case "control":
      return "Ctrl";
    case "shift":
      return "Shift";
    case "alt":
    case "option":
      return "Alt";
    // Every spelling the plugin and older saves may use for the Windows key.
    case "super":
    case "cmd":
    case "command":
    case "meta":
    case "win":
      return "Super";
    default:
      return null;
  }
}

/** Parses a combination; null when the string is not one. */
export function parseCombo(spec: string): ComboSpec | null {
  const parts = spec
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const key = parts[parts.length - 1];
  if (!key) return null;

  const modifiers: ShortcutModifier[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = modifierOf(part);
    if (!modifier) return null;
    modifiers.push(modifier);
  }
  return modifiers.length > 0 ? { modifiers, key } : null;
}

/** Writes a combination in the canonical order; empty when it is incomplete. */
export function formatCombo(modifiers: readonly ShortcutModifier[], key: string): string {
  if (!key || modifiers.length === 0) return "";
  const ordered = SHORTCUT_MODIFIERS.filter((modifier) => modifiers.includes(modifier));
  return [...ordered, key].join("+");
}

/** Keys the picker offers, grouped for the dropdown. */
export const SHORTCUT_KEY_GROUPS: readonly { id: string; keys: readonly string[] }[] = [
  { id: "letters", keys: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"] },
  { id: "digits", keys: [..."0123456789"] },
  { id: "function", keys: Array.from({ length: 12 }, (_, index) => `F${index + 1}`) },
  {
    id: "navigation",
    keys: [
      "Space",
      "Enter",
      "Tab",
      "Esc",
      "Backspace",
      "Delete",
      "Insert",
      "Up",
      "Down",
      "Left",
      "Right",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ],
  },
  {
    id: "symbols",
    keys: ["-", "=", "[", "]", ";", "'", ",", ".", "/", "\\", "`"],
  },
];

export const SHORTCUT_KEYS: ReadonlySet<string> = new Set(
  SHORTCUT_KEY_GROUPS.flatMap((group) => group.keys)
);

/** `event.code` names that are not a letter, a digit or an F-key. */
const CODE_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Tab: "Tab",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

/**
 * The shortcut key an event stands for.
 *
 * Reads `code` rather than `key`: with Shift held `key` is the shifted
 * character (`!` for Shift+1), which would never match what the picker wrote.
 */
export function keyFromEvent(event: KeyboardEvent): string | null {
  const code = event.code;
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return CODE_KEYS[code] ?? null;
}

export function modifiersFromEvent(event: KeyboardEvent): ShortcutModifier[] {
  const modifiers: ShortcutModifier[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.altKey) modifiers.push("Alt");
  if (event.metaKey) modifiers.push("Super");
  return modifiers;
}

/** A bare modifier keydown only updates the modifier row while recording. */
export function isModifierKey(key: string): boolean {
  return key === "Control" || key === "Shift" || key === "Alt" || key === "Meta" || key === "OS";
}

/** Whether a combination matches this keydown, modifiers and all. */
export function comboMatchesEvent(combo: ComboSpec, event: KeyboardEvent): boolean {
  if (keyFromEvent(event) !== combo.key) return false;
  const pressed = modifiersFromEvent(event);
  if (pressed.length !== combo.modifiers.length) return false;
  return combo.modifiers.every((modifier) => pressed.includes(modifier));
}

/**
 * Recognises the two presses that make a double Ctrl.
 *
 * The first press only starts the window; the second within
 * {@link DOUBLE_PRESS_WINDOW_MS} fires it. Auto-repeat is ignored, so holding
 * Ctrl down does not count as pressing it twice, and any other key clears the
 * window so Ctrl+C followed by Ctrl+C is not a double press.
 */
export class DoublePressTracker {
  private startedAt = 0;

  feed(event: KeyboardEvent, now = performance.now()): boolean {
    if (event.repeat) return false;
    if (event.key !== "Control") {
      this.startedAt = 0;
      return false;
    }
    const startedAt = this.startedAt;
    this.startedAt = now;
    return startedAt !== 0 && now - startedAt <= DOUBLE_PRESS_WINDOW_MS;
  }
}

function modifiersAre(event: KeyboardEvent, expected: readonly ShortcutModifier[]): boolean {
  const pressed = modifiersFromEvent(event);
  return pressed.length === expected.length && expected.every((one) => pressed.includes(one));
}

/**
 * Whether this keydown fires the stored shortcut.
 *
 * Combination strings go through {@link comboMatchesEvent}; presets are matched
 * here, with the double Ctrl answered by the caller's tracker.
 */
export function shortcutMatchesEvent(
  spec: string,
  event: KeyboardEvent,
  doubleCtrl: DoublePressTracker
): boolean {
  const preset = presetOf(spec);
  if (!preset) {
    // The tracker is fed either way so switching setups mid-session cannot
    // leave a half-finished double press behind.
    doubleCtrl.feed(event);
    const combo = parseCombo(spec);
    return combo ? comboMatchesEvent(combo, event) : false;
  }

  switch (preset) {
    case "space":
      return keyFromEvent(event) === "Space" && modifiersAre(event, []);
    case "altSpace":
      return keyFromEvent(event) === "Space" && modifiersAre(event, ["Alt"]);
    case "winSpace":
      return keyFromEvent(event) === "Space" && modifiersAre(event, ["Super"]);
    case "doubleCtrl":
      return doubleCtrl.feed(event);
    case "ctrlW":
      return keyFromEvent(event) === "W" && modifiersAre(event, ["Ctrl"]);
  }
}

/** Whether the event landed in something the user is typing into. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

# Global Shortcut Development Guide

This guide explains how to implement global shortcuts in Tauri v2 applications using the `tauri-plugin-global-shortcut` plugin.

## Overview

Global shortcuts allow your application to respond to keyboard combinations even when the app is not focused. This template provides a complete implementation with:

- Keyboard event capture and conversion
- Shortcut registration/unregistration
- UI component for shortcut input
- Permission configuration

## Setup

### 1. Install Plugin

Add to `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-global-shortcut = "2"
```

### 2. Initialize Plugin

In `src-tauri/src/lib.rs`:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::init())
        // ... other plugins
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 3. Configure Permissions

Add to `src-tauri/capabilities/default.json`:

```json
{
  "permissions": [
    "global-shortcut:default",
    "global-shortcut:allow-is-registered",
    "global-shortcut:allow-register",
    "global-shortcut:allow-register-all",
    "global-shortcut:allow-unregister",
    "global-shortcut:allow-unregister-all"
  ]
}
```

### 4. Install Frontend Package

```bash
pnpm add @tauri-apps/plugin-global-shortcut
```

## Implementation

### Utility Functions (`src/lib/shortcut.ts`)

#### Shortcut strings (`src/lib/shortcut-spec.ts`)

A stored shortcut is one string in either of two forms:

- a combination — `Ctrl+Shift+A`, `Super+A` (the Windows key) — which is what
  the plugin can register;
- a preset — `preset:space`, `preset:doubleCtrl`, `preset:altSpace`,
  `preset:winSpace` — for triggers the OS registration API cannot express.
  A preset may also stand for an ordinary combination: `ctrlW` is stored as
  `Ctrl+W`, making it an offer in the picker rather than a stored form of its
  own.

```typescript
import {
  DoublePressTracker,
  formatCombo,
  keyFromEvent,
  modifiersFromEvent,
  parseCombo,
  shortcutMatchesEvent,
} from "@/lib/shortcut-spec";

parseCombo("Ctrl+Shift+A"); // { modifiers: ["Ctrl", "Shift"], key: "A" }
formatCombo(["Super"], "A"); // "Super+A"
keyFromEvent(keyboardEvent); // "A", "Space", "F5", …
```

- `keyFromEvent` reads `event.code`, not `event.key`: with Shift held `key` is
  the shifted character, which would never match what the picker wrote.
- `shortcutMatchesEvent(spec, event, tracker)` answers "does this keydown fire
  the stored shortcut?". The `DoublePressTracker` must be kept by the caller
  across keydowns — the double Ctrl can only be recognised from two events.
- `isEditableTarget(event.target)` is the guard an in-app listener needs before
  it treats a keypress as a shortcut rather than as typing.

**Supported modifiers:** `Ctrl`, `Shift`, `Alt`, `Super` (the Windows key).

**Supported keys:** letters, digits, `F1`–`F12`, `Space`, `Enter`, `Tab`, `Esc`,
backspace/delete/insert, arrows, home/end/page up/page down, and the common
punctuation keys — all in the names the plugin's parser accepts.

#### Register Shortcut

```typescript
import { registerShortcut } from "@/lib/shortcut";

await registerShortcut("Ctrl+Shift+A", () => {
  console.log("Shortcut triggered!");
});

// Replace existing shortcut
await registerShortcut("Ctrl+Shift+B", callback, "Ctrl+Shift+A");
```

#### Unregister Shortcut

```typescript
import { unregisterShortcut, unregisterAllShortcut } from "@/lib/shortcut";

// Unregister specific shortcut
await unregisterShortcut("Ctrl+Shift+A");

// Unregister all shortcuts
await unregisterAllShortcut();
```

### UI Component (`src/components/shortcut-field.tsx`)

One reusable control for every shortcut setting:

```typescript
import { ShortcutField } from "@/components/shortcut-field";

function Settings() {
  const [shortcut, setShortcut] = useState("Ctrl+Shift+A");

  return (
    <ShortcutField
      value={shortcut}
      onChange={setShortcut}
      presets={["space", "doubleCtrl", "altSpace", "winSpace"]}
    />
  );
}
```

**Features:**

- Shows the current trigger as key caps; the picker opens on click
- Presets above the custom picker, when `presets` is passed
- Shift/Ctrl/Alt/Win as toggles, at most two at a time
- The key can be picked from a list or pressed live ("Press keys")
- `onChange("")` clears the setting
- i18n for the placeholder, the presets, the named keys and the picker's labels

The component owns no persistence: it hands back a string and the caller decides
where it goes. A setting the OS registers can still take `presets` as long as
each one stores a combination — `ctrlW` is stored as `Ctrl+W`. Leave them out
when the presets are in-app triggers: a bare Space or a double Ctrl cannot go
through the plugin.

## In-app triggers

A preset that is not a combination can only be handled inside the app, because
the key it watches (Space, Ctrl on its own) would otherwise be swallowed
system-wide:

```typescript
import { DoublePressTracker, isEditableTarget, shortcutMatchesEvent } from "@/lib/shortcut-spec";

const doubleCtrl = new DoublePressTracker();

function onKeyDown(event: KeyboardEvent) {
  if (isEditableTarget(event.target)) return;
  if (shortcutMatchesEvent(shortcut, event, doubleCtrl)) {
    event.preventDefault();
    openQuickPreview();
  }
}

useEffect(() => {
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [shortcut]);
```

Because the listener lives in the webview, such a trigger only fires while the
app's window has focus — which is also what makes it safe to give it Space. The
setting's "?" tip should say so.

## Complete Example

```typescript
import { useEffect, useState } from "react";
import { ShortcutField } from "@/components/shortcut-field";
import { registerShortcut, unregisterShortcut } from "@/lib/shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";

function Settings() {
  const [shortcut, setShortcut] = useState("Ctrl+Shift+A");

  useEffect(() => {
    // Register shortcut to show window
    const setupShortcut = async () => {
      await registerShortcut(shortcut, async () => {
        const window = getCurrentWindow();
        await window.show();
        await window.setFocus();
      });
    };

    setupShortcut();

    // Cleanup on unmount
    return () => {
      unregisterShortcut(shortcut);
    };
  }, [shortcut]);

  return (
    <div>
      <label>Global Shortcut:</label>
      <ShortcutField value={shortcut} onChange={setShortcut} />
    </div>
  );
}
```

## Best Practices

1. **Always Unregister**: Clean up shortcuts when component unmounts or shortcut changes
2. **Validate Input**: A combination handed to OS registration needs at least one
   modifier (presets are in-app and never registered)
3. **Avoid Conflicts**: Check if shortcut is already registered before registering
4. **User Feedback**: Show toast notifications when a shortcut is set/changed
5. **Persistence**: Store user-defined shortcuts in the config file, per the
   project's storage rule; only the legacy show-main shortcut still lives in
   `localStorage`

## Troubleshooting

### Shortcut Not Working

- Check if shortcut is already registered by system or another app
- Verify permissions in `capabilities/default.json`
- Ensure plugin is initialized in `src-tauri/src/lib.rs`

### Shortcut Conflicts

```typescript
import { isRegistered } from "@tauri-apps/plugin-global-shortcut";

const registered = await isRegistered("Ctrl+Shift+A");
if (registered) {
  console.warn("Shortcut already registered");
}
```

## API Reference

### `parseCombo(spec: string): ComboSpec | null`

Splits a combination into its modifiers and key; null when the string is not a
combination. `formatCombo` is the inverse and writes the canonical order.

### `shortcutMatchesEvent(spec, event, tracker): boolean`

Whether this keydown fires the stored shortcut, preset or combination. The
`DoublePressTracker` is the caller's, kept across keydowns for the double Ctrl.

### `registerShortcut(shortcut: string, callback: () => void, oldShortcut?: string): Promise<void>`

Registers a global shortcut with callback function.

**Parameters:**

- `shortcut`: Shortcut string to register
- `callback`: Function to execute when shortcut is pressed
- `oldShortcut`: Optional previous shortcut to unregister

### `unregisterShortcut(shortcut?: string): Promise<void>`

Unregisters a specific shortcut.

### `unregisterAllShortcut(): Promise<void>`

Unregisters all shortcuts registered by the application.

## Related Documentation

- [Tauri Global Shortcut Plugin](https://v2.tauri.app/plugin/global-shortcut/)
- [Keyboard Event Reference](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent)

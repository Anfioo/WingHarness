// Sandboxed document frames cannot bubble keyboard events into the app window.
// Let the app decide which keys it handles so custom shortcuts and modifiers work too.
export function forwardPreviewKey(event: KeyboardEvent): void {
  const find =
    (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f";
  if (
    !find &&
    (event.target as HTMLElement | null)?.closest("input,textarea,select,[contenteditable]")
  )
    return;
  if (
    ["ArrowUp", "ArrowDown"].includes(event.key) &&
    (event.target as HTMLElement | null)?.closest("button,[role=tree],[role=slider]")
  )
    return;
  const forwarded = new KeyboardEvent(event.type, {
    key: event.key,
    code: event.code,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    isComposing: event.isComposing,
    cancelable: true,
  });
  if (!window.dispatchEvent(forwarded)) event.preventDefault();
}

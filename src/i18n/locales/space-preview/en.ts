// Space preview strings. Every later lane adds keys here, in both files at
// once: the two objects must always carry the same key set.
export default {
  title: "File Preview",
  subtitle: "Preview a file without leaving the app.",
  window: {
    close: "Close",
    previous: "Previous",
    next: "Next",
    multiSelect: "{{count}} selected",
  },
  toolbar: {
    openInWindow: "Open in a window",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    fit: "Fit to window",
  },
  settings: {
    spaceEnabled: "Space preview",
    spaceEnabledHint: "Press Space on a selected file in Explorer, the desktop or Everything.",
    readingWidth: "Reading width",
    fontSize: "Font size",
    defaultEncoding: "Default encoding",
  },
  encoding: {
    auto: "Auto detect",
    utf8: "UTF-8",
    utf16le: "UTF-16 LE",
    utf16be: "UTF-16 BE",
    gb18030: "GB18030",
    big5: "Big5",
    windows1252: "Windows-1252",
    shiftJis: "Shift-JIS",
  },
  error: {
    notAuthorized: "This file was not opened from the preview, so it cannot be read.",
    notFound: "The file no longer exists.",
    tooLarge: "The file is too large to preview.",
    invalidInput: "The request was invalid.",
    unsupported: "This format is not supported.",
    internal: "Something went wrong while reading the file.",
  },
  unsupported: {
    title: "No preview for this format",
    body: "This file can still be opened with the system default application.",
  },
  editor: {
    save: "Save",
    saving: "Saving…",
    discardConfirm: "Discard the unsaved changes?",
    saved: "Saved",
  },
};

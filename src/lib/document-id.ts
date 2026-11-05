/**
 * A stable id for the document (page load) this code is running in.
 *
 * A window loads the document once — in-app navigation swaps the page component
 * without reloading it — so every import shares this value for the window's whole
 * life, and a genuine reload (or a new window) gets a fresh one.
 *
 * It exists to tell one document from the next on the backend. A plugin's
 * native webview outlives the React tree that asked for it, so when the window
 * changes, the arriving document must be able to claim its webviews and the
 * departing one must not be able to take them away again — even though the
 * depart and the arrival are two asynchronous calls that can land in either
 * order. The window label alone cannot tell them apart: both loads share it.
 */
export const DOCUMENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Browser-language strings for every UI surface.
//
// Chrome and Firefox both implement `i18n.getMessage`, backed by
// `_locales/<locale>/messages.json`; there is no bundled translation table, so
// the manifest's `default_locale` decides the fallback. The API reports the
// browser's own UI language and needs no language switcher of its own.
//
// This file only declares `t` and `applyI18n`, never `B` or any other global
// that shared.js owns: content scripts and the service worker load both files
// into one scope, and a duplicate top-level `const` would fail the whole script.

/** A localized message, or the key itself when the locale is missing it. */
function t(key, substitutions) {
  const api = globalThis.browser ?? globalThis.chrome;
  return api?.i18n?.getMessage(key, substitutions) || key;
}

/**
 * Fills static markup from the locale files:
 *   data-i18n             → textContent
 *   data-i18n-placeholder → placeholder
 *   data-i18n-title       → title and aria-label
 *
 * Accepts a ShadowRoot as well as a Document, which is how the in-page prompt
 * localizes itself without touching the host page.
 */
function applyI18n(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.getAttribute("data-i18n"));
  }
  for (const el of scope.querySelectorAll("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  }
  for (const el of scope.querySelectorAll("[data-i18n-title]")) {
    const text = t(el.getAttribute("data-i18n-title"));
    el.setAttribute("title", text);
    el.setAttribute("aria-label", text);
  }
}

/**
 * Whether this build can show developer affordances: the inspector, and the
 * reload that goes with it.
 *
 * Debug builds always can. A packaged build only when it was made with
 * `BUILD_DEV=1`, which is what tells the backend to carry the `devtools`
 * feature and the frontend to keep the entries.
 */
export const DEV_BUILD = import.meta.env.DEV || import.meta.env.BUILD_DEV === "1";

// elkjs is EPL-2.0, which the licence gate in docs/UPSTREAM_PROJECTS.md does not
// allow. Vite aliases the package here so its code stays out of the bundle;
// mermaid reaches this module only when a diagram asks for an ELK layout.
export default class ElkUnavailable {
  layout(): Promise<never> {
    return Promise.reject(
      new Error("The ELK layout is not available in this build. Use the default dagre layout.")
    );
  }
}

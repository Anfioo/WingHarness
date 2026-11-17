import { CodegApp } from "./page";

/**
 * Codeg, development mode: the same page on a `codeg-server` built from a
 * checkout.
 *
 * The route and its sidebar entry are dropped from a packaged build
 * (`appRoutes` filters `devOnly`), because the paths it needs only exist on a
 * machine with the Codeg sources on it.
 */
export default function CodegDevPage() {
  return <CodegApp mode="dev" />;
}

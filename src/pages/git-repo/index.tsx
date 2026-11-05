import { WelcomeView } from "./welcome-view";

/**
 * The Git feature's page of the main window: the picker. Picking a repository
 * there opens it in a window of its own (`@/lib/git-windows`), so this route
 * never shows a repository itself and carries no `?path=`.
 */
export default function GitRepoPage() {
  return <WelcomeView />;
}

import { CodegApp } from "./page";

/**
 * Codeg, installed mode.
 *
 * The server is the `codeg-server` archive this app downloaded from the Codeg
 * release and unpacked under the data directory — no checkout involved, which is
 * what makes the page part of the shipped app rather than a developer's tool.
 */
export default function CodegPage() {
  return <CodegApp mode="installed" />;
}

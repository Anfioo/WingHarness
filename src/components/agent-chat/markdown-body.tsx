import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";

// Stateless singletons: a module-level object keeps the prop reference stable.
const PLUGINS = { cjk, code, math, mermaid };

const SAMPLE =
  "**Agent chat** renders Markdown with Streamdown.\n\n```ts\nconst ready = true;\n```";

export function AgentMarkdownBody() {
  return (
    <div className="agent-chat-md">
      <Streamdown plugins={PLUGINS}>{SAMPLE}</Streamdown>
    </div>
  );
}

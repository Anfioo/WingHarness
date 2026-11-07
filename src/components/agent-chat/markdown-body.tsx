import { memo } from "react";
import type { AnchorHTMLAttributes, HTMLAttributes, JSX } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Streamdown, type Components } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { useAppTranslation } from "@/hooks/use-app-translation";
// KaTeX ships its own layout rules; our overrides in `preview.css` come after.
import "katex/dist/katex.min.css";

// Stateless singletons: a module-level object keeps the prop reference stable.
const PLUGINS = { code, math, mermaid, cjk };
// Links are handed to the OS browser by the `a` override below, so Streamdown's
// own confirmation modal would be a redundant second gate.
const LINK_SAFETY = { enabled: false };

const EXTERNAL_LINK = /^(?:https?:|mailto:)/i;
/** Past this length a single parse is slow enough to stall scrolling. */
const MAX_MARKDOWN_CHARS = 32_000;

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };
type PreProps = HTMLAttributes<HTMLPreElement> & { node?: unknown };

function MarkdownLink({ node: _node, href, children, ...rest }: AnchorProps): JSX.Element {
  const url = href ?? "";
  const external = EXTERNAL_LINK.test(url);

  return (
    <a
      {...rest}
      href={url}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      onClick={(event) => {
        // The webview must never navigate away from the app.
        event.preventDefault();
        if (!external) return;
        void openUrl(url).catch((error: unknown) => {
          console.warn("agent-chat: failed to open link", url, error);
        });
      }}
    >
      {children}
    </a>
  );
}

function MarkdownInlineCode({
  node: _node,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { node?: unknown }): JSX.Element {
  return (
    <code {...rest} className="bg-muted rounded px-1 py-0.5 text-[0.9em]">
      {children}
    </code>
  );
}

function MarkdownPre({ node: _node, children, ...rest }: PreProps): JSX.Element {
  return (
    <pre {...rest} className="overflow-x-auto">
      {children}
    </pre>
  );
}

const COMPONENTS: Components = {
  a: MarkdownLink,
  inlineCode: MarkdownInlineCode,
  pre: MarkdownPre,
};

function AgentMarkdownBodyBase({ text }: { text: string }): JSX.Element {
  const { t } = useAppTranslation();

  if (text.length > MAX_MARKDOWN_CHARS) {
    return (
      <div className="agent-chat-md">
        <p className="text-muted-foreground text-xs">{t("agentChat.markdown.tooLarge")}</p>
        <pre className="font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>
      </div>
    );
  }

  return (
    <div className="agent-chat-md">
      <Streamdown mode="static" plugins={PLUGINS} components={COMPONENTS} linkSafety={LINK_SAFETY}>
        {text}
      </Streamdown>
    </div>
  );
}

export const AgentMarkdownBody = memo(AgentMarkdownBodyBase);

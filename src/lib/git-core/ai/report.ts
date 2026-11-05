export type AiSeverity = "bug" | "risk" | "nit";

export interface AiReportBullet {
  kind: "bullet";
  text: string;
  severity: AiSeverity | null;
}

export interface AiReportParagraph {
  kind: "paragraph";
  text: string;
}

export type AiReportBlock = AiReportBullet | AiReportParagraph;

export interface AiReportSection {
  label: string | null;
  blocks: AiReportBlock[];
}

export type AiVerdictTone = "success" | "danger" | "attention";

export interface AiVerdict {
  text: string;
  tone: AiVerdictTone;
}

export interface AiReport {
  sections: AiReportSection[];
  structured: boolean;
  verdict: AiVerdict | null;
}

const LABEL_LINE = /^\s*\*\*([^*\n]+?)\*\*:?\s*$/;
const BULLET_LINE = /^\s*[-*•]\s+(.*)$/;
const SEVERITY_PREFIX = /^(bug|risk|nit)\b\s*[:|—–-]?\s*/i;
const VERDICT_LABEL = /^verdict$/i;
const VERDICT_DANGER = /needs changes|not safe|do not merge|don't merge|blocker|must fix/i;
const VERDICT_SAFE = /looks safe|safe to merge|looks good|good to go|lgtm|no issues/i;

export function verdictTone(text: string): AiVerdictTone {
  if (VERDICT_DANGER.test(text)) return "danger";
  if (VERDICT_SAFE.test(text)) return "success";
  return "attention";
}

export function parseAiReport(text: string): AiReport {
  const sections: AiReportSection[] = [];
  let current: AiReportSection = { label: null, blocks: [] };
  let afterBlank = true;

  const close = () => {
    if (current.blocks.length > 0 || current.label) sections.push(current);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      afterBlank = true;
      continue;
    }
    const label = LABEL_LINE.exec(line);
    if (label) {
      close();
      current = { label: label[1].trim(), blocks: [] };
      afterBlank = true;
      continue;
    }
    const bullet = BULLET_LINE.exec(line);
    const last = current.blocks[current.blocks.length - 1];
    if (bullet) {
      const body = bullet[1].trim();
      const severity = SEVERITY_PREFIX.exec(body);
      current.blocks.push({
        kind: "bullet",
        text: severity ? body.slice(severity[0].length).trim() || body : body,
        severity: severity ? (severity[1].toLowerCase() as AiSeverity) : null,
      });
    } else if (last && !afterBlank) {
      last.text =
        last.kind === "bullet" ? `${last.text} ${line.trim()}` : `${last.text}\n${line.trim()}`;
    } else {
      current.blocks.push({ kind: "paragraph", text: line.trim() });
    }
    afterBlank = false;
  }
  close();

  const structured = sections.some((s) => s.label !== null);
  const verdictSection = sections.find((s) => s.label && VERDICT_LABEL.test(s.label));
  const verdictText =
    verdictSection?.blocks
      .map((b) => b.text)
      .join(" ")
      .trim() ?? "";
  return {
    sections: sections.filter((s) => s.blocks.length > 0),
    structured,
    verdict: verdictText ? { text: verdictText, tone: verdictTone(verdictText) } : null,
  };
}

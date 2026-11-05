export type CommitStylePreset = "conventional" | "plain" | "strict" | "custom";

export type CommitLanguage = "zh" | "en";

export interface CommitPrefixRule {
  pattern: string;
  prefix: string;
}

export interface CommitStyle {
  preset: CommitStylePreset;
  language: CommitLanguage;
  instructions: string;
  prefixRules: CommitPrefixRule[];
}

export interface ReviewStyle {
  instructions: string;
}

export interface AiStyleConfig {
  commit: CommitStyle;
  review: ReviewStyle;
}

export const DEFAULT_COMMIT_STYLE: CommitStyle = {
  preset: "conventional",
  language: "zh",
  instructions: "",
  prefixRules: [],
};

export const DEFAULT_REVIEW_STYLE: ReviewStyle = {
  instructions: "",
};

export const DEFAULT_AI_STYLE: AiStyleConfig = {
  commit: DEFAULT_COMMIT_STYLE,
  review: DEFAULT_REVIEW_STYLE,
};

export const PROJECT_REVIEW_FILE = ".angkorgit/review.md";

export const COMMIT_STYLE_PRESETS: Record<
  CommitStylePreset,
  { labelKey: string; descriptionKey: string }
> = {
  conventional: {
    labelKey: "gitRepo.extras.commitStyle.presets.conventional",
    descriptionKey: "gitRepo.extras.commitStyle.presets.conventionalDesc",
  },
  plain: {
    labelKey: "gitRepo.extras.commitStyle.presets.plain",
    descriptionKey: "gitRepo.extras.commitStyle.presets.plainDesc",
  },
  strict: {
    labelKey: "gitRepo.extras.commitStyle.presets.strict",
    descriptionKey: "gitRepo.extras.commitStyle.presets.strictDesc",
  },
  custom: {
    labelKey: "gitRepo.extras.commitStyle.presets.custom",
    descriptionKey: "gitRepo.extras.commitStyle.presets.customDesc",
  },
};

const TICKET_PATTERN = /[A-Za-z][A-Za-z0-9]+-\d+/;

function branchMatches(pattern: string, branch: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(branch);
}

function expandPrefixTokens(prefix: string, branch: string): string | null {
  const suffix = branch.includes("/") ? branch.slice(branch.lastIndexOf("/") + 1) : branch;
  const ticket = branch.match(TICKET_PATTERN)?.[0] ?? null;
  if (prefix.includes("{ticket}") && !ticket) return null;
  return prefix
    .replace(/\{branch\}/g, () => branch)
    .replace(/\{suffix\}/g, () => suffix)
    .replace(/\{ticket\}/g, () => ticket ?? "");
}

export function resolveCommitPrefix(
  rules: CommitPrefixRule[],
  branch: string | null
): string | null {
  if (!branch) return null;
  for (const rule of rules) {
    const pattern = rule.pattern.trim();
    const prefix = rule.prefix.trim();
    if (!pattern || !prefix) continue;
    if (!branchMatches(pattern, branch)) continue;
    const expanded = expandPrefixTokens(prefix, branch);
    if (expanded !== null) return expanded;
  }
  return null;
}

export function ensureCommitPrefix(message: string, prefix: string): string {
  const trimmed = message.trimStart();
  if (trimmed.startsWith(prefix)) return message;
  return `${prefix} ${trimmed}`;
}

const BODY_TAIL = " Then a blank line and a short body only if the change needs explanation.";

const CONVENTIONAL_INSTRUCTIONS =
  "Write a conventional-commit style message. First line: type(scope): summary under 72 chars." +
  BODY_TAIL;
const PLAIN_INSTRUCTIONS =
  "Write a plain commit message. First line: an imperative summary under 72 chars with no type prefix." +
  BODY_TAIL;

const STRICT_INSTRUCTIONS = `Write a conventional-commit message using exactly this template:
<type>[optional scope]: <description>

- change point
- change point

[optional footer(s)]

Rules:
- type is one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.
- description is one line under 50 characters, starts with a verb such as add, fix, refactor or remove, and says what this commit does, not why it exists.
- Add a scope only when it clearly names the module or area; otherwise omit it.
- The body is a bullet list, one bullet per meaningful change: what changed, then why it matters. Never repeat the title, and omit the body when the title already says everything.
- Mark a breaking change with "!" after the type or scope and a "BREAKING CHANGE:" footer only when compatibility is actually broken.
- Describe only what the diff shows; do not ask questions, run commands, or restate these rules.`;

const PRESET_INSTRUCTIONS: Record<Exclude<CommitStylePreset, "custom">, string> = {
  conventional: CONVENTIONAL_INSTRUCTIONS,
  plain: PLAIN_INSTRUCTIONS,
  strict: STRICT_INSTRUCTIONS,
};

const LANGUAGE_INSTRUCTIONS: Record<CommitLanguage, string> = {
  zh: "Write the description and body in Chinese.",
  en: "Write the message in English.",
};

function presetInstructions(style: CommitStyle): string {
  if (style.preset !== "custom") return PRESET_INSTRUCTIONS[style.preset];
  return style.instructions.trim() || CONVENTIONAL_INSTRUCTIONS;
}

export function commitStyleInstructions(style: CommitStyle, prefix: string | null): string {
  const base = presetInstructions(style);
  const prefixLine = prefix
    ? ` Start the first line with exactly "${prefix} " and add no other type prefix.`
    : "";
  const language = LANGUAGE_INSTRUCTIONS[style.language ?? "zh"];
  return `${base}${prefixLine} ${language} Output the message only, no fencing.`;
}

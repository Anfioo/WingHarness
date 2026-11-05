/** Types for reading Claude Code's own session history off disk. */

/** One project directory under `~/.claude/projects`. */
export interface ClaudeProjectSummary {
  /** The directory name, which is also the key the other commands take. */
  slug: string;
  /** The working directory the sessions ran in, for display. */
  path: string;
  sessionCount: number;
  modifiedMs: number;
}

export interface ClaudeProjectList {
  projects: ClaudeProjectSummary[];
  /** The directory scanned, so an empty list can be explained. */
  root: string;
}

/** One project's sessions, loaded when the navigator expands it. */
export interface ClaudeProjectSessionList {
  project: string;
  path: string;
  sessions: ClaudeSessionSummary[];
}

/** Where a copy this app wrote came from. */
export interface ClaudeSessionOrigin {
  /** `clone` for a copy of the whole session, `fork` for a branch taken at one
   * of its messages. */
  kind: "clone" | "fork";
  sourceSessionId: string;
  sourceProject: string;
  /** The message a fork branches from. */
  forkUuid?: string;
  /** The name the copy was given. */
  title: string;
}

/** A session copied out of the one being viewed: one message becoming two. */
export interface ClaudeSessionBranch {
  sessionId: string;
  project: string;
  title: string;
  /** The message this branch leaves from, when it is a fork. */
  forkUuid?: string;
  createdMs: number;
}

/** A session file this app just wrote. */
export interface ClaudeNewSession {
  sessionId: string;
  project: string;
  /** How many stored rows were carried over. */
  lines: number;
}

/** One stored session, as shown in the history drawer. */
export interface ClaudeSessionSummary {
  id: string;
  title: string;
  /** First real user message, for a fuller tooltip than the title. */
  preview: string;
  modifiedMs: number;
  /** Present only when this app made the session, in which case the list says
   * which conversation it was copied from. */
  origin?: ClaudeSessionOrigin;
}

export interface ClaudeSessionList {
  sessions: ClaudeSessionSummary[];
  /** The directory that was scanned, so an empty list can be explained. */
  dir: string;
}

export type ClaudeHistoryKind = "user" | "assistant" | "thinking" | "tool";

/**
 * One transcript record. A tool result is not a record of its own: it arrives on
 * the `tool` record it belongs to, in `resultContent` (raw, so it renders the
 * same way a live result does) and `isError`.
 */
export interface ClaudeHistoryRecord {
  kind: ClaudeHistoryKind;
  uuid: string;
  text: string;
  parentToolUseId: string | null;
  /** The row's own ISO-8601 timestamp, for a node caption. */
  timestamp?: string;
  toolName?: string;
  toolUseId?: string;
  input?: Record<string, unknown> | null;
  resultContent?: unknown;
  isError?: boolean;
}

export interface ClaudeLoadedSession {
  /** The id to continue the conversation with. */
  sessionId: string;
  records: ClaudeHistoryRecord[];
  /** Sessions copied out of this one, so the message a branch leaves from can
   * be shown as two. */
  branches: ClaudeSessionBranch[];
}

/**
 * One turn of a conversation, as the workflow canvas draws it: what the user
 * asked, and the last thing the CLI said before the next question.
 *
 * What happened in between — the thinking, the tool calls — is not carried: the
 * workflow view shows the shape of a conversation, not its plumbing.
 */
export interface ClaudeWorkflowTurn {
  /** The message that opened the turn. Absent for a conversation that begins
   * with the CLI speaking. */
  questionUuid?: string;
  question: string;
  /** The CLI's last message in the turn. A fork taken here branches from it,
   * and it is the id a copy of the turn shares with its source. */
  answerUuid?: string;
  answer: string;
  timestamp?: string;
}

/** One conversation taking part in a workflow: the conversation a family is
 * named after, or a clone or fork taken out of it. */
export interface ClaudeWorkflowSession {
  sessionId: string;
  project: string;
  /** The name the conversation is listed under. */
  title: string;
  /** The conversation this one was copied from; the session's own name when it
   * is the one the family is named after. */
  sourceSessionId: string;
  sourceProject: string;
  /** The message this fork leaves from. Absent on a clone, and on the
   * conversation a family is named after. */
  forkUuid?: string;
  /** When the copy was made, or 0 for a conversation that is not one. */
  createdMs: number;
  modifiedMs: number;
  turns: ClaudeWorkflowTurn[];
  /** Set when the session file could not be read, so the canvas can say why a
   * chain stops there. */
  error?: string;
}

/** One conversation family, as the workflow page's navigator lists it: the
 * session everything was copied from, and what hangs off it. */
export interface ClaudeFamilySummary {
  rootSessionId: string;
  rootProject: string;
  /** The session's own name. */
  title: string;
  modifiedMs: number;
  /** When the newest copy in the family was made. */
  lastMs: number;
  copies: number;
  forks: number;
  clones: number;
}

export interface ClaudeFamilyList {
  families: ClaudeFamilySummary[];
  /** The directory the lineage files live in. */
  store: string;
}

/** One conversation family, with the turns a canvas needs to draw it. */
export interface ClaudeFamilyGraph {
  /** The session the family is named after. */
  rootSessionId: string;
  /** The conversation a family is named after first, then each copy in the
   * order it was made. */
  sessions: ClaudeWorkflowSession[];
  /** The lineage file the family was read out of. */
  store: string;
}

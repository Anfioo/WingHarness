import { invokeCommand } from "../../base";
import type {
  ClaudeFamilyGraph,
  ClaudeFamilyList,
  ClaudeLoadedSession,
  ClaudeNewSession,
  ClaudeProjectList,
  ClaudeProjectSessionList,
  ClaudeSessionList,
} from "./types";

/** Lists the stored sessions of one working directory, newest first. */
export function listClaudeSessions(cwd: string): Promise<ClaudeSessionList> {
  return invokeCommand("list_claude_sessions", { cwd });
}

/** Reads one session's transcript, ordered as the conversation actually ran. */
export function loadClaudeSession(cwd: string, sessionId: string): Promise<ClaudeLoadedSession> {
  return invokeCommand("load_claude_session", { cwd, sessionId });
}

/** Lists every project directory that holds sessions, newest activity first. */
export function listClaudeProjects(): Promise<ClaudeProjectList> {
  return invokeCommand("list_claude_projects", {});
}

/** Lists one project's sessions, newest first. */
export function listClaudeProjectSessions(project: string): Promise<ClaudeProjectSessionList> {
  return invokeCommand("list_claude_project_sessions", { project });
}

/** Reads one session of a project named by its directory. */
export function loadClaudeProjectSession(
  project: string,
  sessionId: string
): Promise<ClaudeLoadedSession> {
  return invokeCommand("load_claude_project_session", { project, sessionId });
}

/** Copies a whole session to a new session id. The original is never touched. */
export function cloneClaudeSession(
  project: string,
  sessionId: string,
  title?: string
): Promise<ClaudeNewSession> {
  return invokeCommand("clone_claude_session", { project, sessionId, title });
}

/** Branches a session at `forkUuid`: the copy ends at that message. */
export function forkClaudeSession(
  project: string,
  sessionId: string,
  forkUuid: string,
  title?: string
): Promise<ClaudeNewSession> {
  return invokeCommand("fork_claude_session", { project, sessionId, forkUuid, title });
}

/**
 * The conversation families: a conversation plus every clone and fork taken out
 * of it, one entry per family. Relationships come from this app's own data
 * directory; nothing is read off the session files here.
 */
export function listClaudeFamilies(): Promise<ClaudeFamilyList> {
  return invokeCommand("list_claude_families", {});
}

/**
 * One family, with each conversation's turns clipped to what a node card can
 * show. Any session of the family names it: a fork is resolved up to the
 * conversation the family is named after, so opening a fork shows the trunk it
 * was taken from as well as the branch itself.
 */
export function loadClaudeFamily(project: string, sessionId: string): Promise<ClaudeFamilyGraph> {
  return invokeCommand("load_claude_family", { project, sessionId });
}

/** Writes text to a path the user picked in a native save dialog. */
export function saveTextFile(path: string, content: string): Promise<void> {
  return invokeCommand("save_text_file", { path, content });
}

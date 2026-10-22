import { invokeCommand } from "../../base";

/** A note as it comes back from disk: POSIX path with a leading slash. */
export interface NoteFile {
  path: string;
  content: string;
}

/** The whole notes tree: every file and every directory, so empty folders persist. */
export interface NoteTree {
  files: NoteFile[];
  directories: string[];
}

/** Reads every note under the notes root. */
export function notesList(): Promise<NoteTree> {
  return invokeCommand("notes_list", {});
}

/** Writes a note, creating any missing parent directories. */
export function notesWrite(path: string, content: string): Promise<void> {
  return invokeCommand("notes_write", { path, content });
}

/** Creates a directory, and the ones above it. */
export function notesMkdir(path: string): Promise<void> {
  return invokeCommand("notes_mkdir", { path });
}

/** Removes a file, or a directory and everything under it. */
export function notesDelete(path: string): Promise<void> {
  return invokeCommand("notes_delete", { path });
}

/** Renames or moves a file or directory. */
export function notesRename(from: string, to: string): Promise<void> {
  return invokeCommand("notes_rename", { from, to });
}

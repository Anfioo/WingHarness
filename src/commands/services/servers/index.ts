// Server manager command service.
//
// Thin, one-to-one wrappers over the `server-core` Rust commands. The engine
// arguments are snake_case on the Rust side; Tauri maps the camelCase keys
// sent here onto them. This module is frozen: other lanes call it as-is.
//
// Rejected calls throw the engine's `{ code, message, detail }` object; use
// `isServerError` / `serverErrorCode` from `./types` to branch on `code`.

import { invokeCommand } from "../../base";
import type {
  ConflictPolicy,
  ConnectOutcome,
  ConnectionState,
  HostKeyRecord,
  MetricsSample,
  SecretKind,
  ServerPrefs,
  ServerProfile,
  ServerProfileInput,
  ServerProfilesView,
  SessionInfo,
  SftpEntry,
  TransferDirection,
  TransferSnapshot,
} from "./types";

// Base64 helpers: terminal I/O crosses the boundary as base64 so arbitrary
// bytes survive the JSON IPC channel.

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Profiles.

export async function serverProfilesList(): Promise<ServerProfilesView> {
  return await invokeCommand<Record<string, never>, ServerProfilesView>("server_profiles_list", {});
}

export async function serverProfileCreate(input: ServerProfileInput): Promise<ServerProfile> {
  return await invokeCommand<{ input: ServerProfileInput }, ServerProfile>(
    "server_profile_create",
    { input }
  );
}

export async function serverProfileUpdate(
  id: string,
  input: ServerProfileInput
): Promise<ServerProfile> {
  return await invokeCommand<{ id: string; input: ServerProfileInput }, ServerProfile>(
    "server_profile_update",
    { id, input }
  );
}

/** Deletes the profile together with its host key and any legacy keychain entry. */
export async function serverProfileDelete(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("server_profile_delete", { id });
}

export async function serverProfileReorder(ids: string[]): Promise<void> {
  return await invokeCommand<{ ids: string[] }, void>("server_profile_reorder", { ids });
}

// Credentials. These write the plaintext fields of `servers.json`; no keychain
// entry is touched any more.

export async function serverSecretSet(
  profileId: string,
  kind: SecretKind,
  value: string
): Promise<void> {
  return await invokeCommand<{ profileId: string; kind: SecretKind; value: string }, void>(
    "server_secret_set",
    { profileId, kind, value }
  );
}

export async function serverSecretClear(profileId: string, kind: SecretKind): Promise<void> {
  return await invokeCommand<{ profileId: string; kind: SecretKind }, void>("server_secret_clear", {
    profileId,
    kind,
  });
}

// Host keys.

export async function serverHostKeyGet(profileId: string): Promise<HostKeyRecord | null> {
  return await invokeCommand<{ profileId: string }, HostKeyRecord | null>("server_host_key_get", {
    profileId,
  });
}

export async function serverHostKeyForget(profileId: string): Promise<void> {
  return await invokeCommand<{ profileId: string }, void>("server_host_key_forget", { profileId });
}

/** Only valid inside the `host-key-unknown` flow, after the user confirmed. */
export async function serverHostKeyTrustPending(
  profileId: string,
  fingerprint: string
): Promise<void> {
  return await invokeCommand<{ profileId: string; fingerprint: string }, void>(
    "server_host_key_trust_pending",
    { profileId, fingerprint }
  );
}

// Preferences.

export async function serverPrefsGet(): Promise<ServerPrefs> {
  return await invokeCommand<Record<string, never>, ServerPrefs>("server_prefs_get", {});
}

export async function serverPrefsSet(prefs: ServerPrefs): Promise<ServerPrefs> {
  return await invokeCommand<{ prefs: ServerPrefs }, ServerPrefs>("server_prefs_set", { prefs });
}

// SSH sessions.

export async function serverConnect(
  profileId: string,
  cols: number,
  rows: number,
  trustHostKey: boolean
): Promise<ConnectOutcome> {
  return await invokeCommand<
    { profileId: string; cols: number; rows: number; trustHostKey: boolean },
    ConnectOutcome
  >("server_connect", { profileId, cols, rows, trustHostKey });
}

export async function serverWrite(sessionId: string, data: Uint8Array): Promise<void> {
  return await invokeCommand<{ sessionId: string; data: string }, void>("server_write", {
    sessionId,
    data: bytesToBase64(data),
  });
}

export async function serverResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return await invokeCommand<{ sessionId: string; cols: number; rows: number }, void>(
    "server_resize",
    { sessionId, cols, rows }
  );
}

/** Closes one shell channel; the connection stays up for other sessions. */
export async function serverDisconnect(sessionId: string): Promise<void> {
  return await invokeCommand<{ sessionId: string }, void>("server_disconnect", { sessionId });
}

/** Closes the profile's connection and its SFTP subsystem. */
export async function serverConnectionClose(profileId: string): Promise<void> {
  return await invokeCommand<{ profileId: string }, void>("server_connection_close", {
    profileId,
  });
}

export async function serverSessionsList(): Promise<SessionInfo[]> {
  return await invokeCommand<Record<string, never>, SessionInfo[]>("server_sessions_list", {});
}

export async function serverConnectionState(profileId: string): Promise<ConnectionState> {
  return await invokeCommand<{ profileId: string }, ConnectionState>("server_connection_state", {
    profileId,
  });
}

/** Buffered samples of one profile, oldest first. Empty when nothing is running. */
export async function serverMetricsHistory(profileId: string): Promise<MetricsSample[]> {
  return await invokeCommand<{ profileId: string }, MetricsSample[]>("server_metrics_history", {
    profileId,
  });
}

// Remote files.

export async function serverSftpHome(profileId: string): Promise<string> {
  return await invokeCommand<{ profileId: string }, string>("server_sftp_home", { profileId });
}

export async function serverSftpList(profileId: string, path: string): Promise<SftpEntry[]> {
  return await invokeCommand<{ profileId: string; path: string }, SftpEntry[]>("server_sftp_list", {
    profileId,
    path,
  });
}

export async function serverSftpStat(profileId: string, path: string): Promise<SftpEntry> {
  return await invokeCommand<{ profileId: string; path: string }, SftpEntry>("server_sftp_stat", {
    profileId,
    path,
  });
}

export async function serverSftpMkdir(profileId: string, path: string): Promise<void> {
  return await invokeCommand<{ profileId: string; path: string }, void>("server_sftp_mkdir", {
    profileId,
    path,
  });
}

export async function serverSftpRename(profileId: string, from: string, to: string): Promise<void> {
  return await invokeCommand<{ profileId: string; from: string; to: string }, void>(
    "server_sftp_rename",
    { profileId, from, to }
  );
}

/** `isDir` asks for a recursive delete; symlinks are removed, not followed. */
export async function serverSftpDelete(
  profileId: string,
  path: string,
  isDir: boolean
): Promise<void> {
  return await invokeCommand<{ profileId: string; path: string; isDir: boolean }, void>(
    "server_sftp_delete",
    { profileId, path, isDir }
  );
}

/** Reads up to 2 MB; larger files fail with `file-too-large`. */
export async function serverSftpReadText(profileId: string, path: string): Promise<string> {
  return await invokeCommand<{ profileId: string; path: string }, string>("server_sftp_read_text", {
    profileId,
    path,
  });
}

/** Writes up to 2 MB; larger content fails with `file-too-large`. */
export async function serverSftpWriteText(
  profileId: string,
  path: string,
  content: string
): Promise<void> {
  return await invokeCommand<{ profileId: string; path: string; content: string }, void>(
    "server_sftp_write_text",
    { profileId, path, content }
  );
}

// Local files.

export async function serverLocalHome(): Promise<string> {
  return await invokeCommand<Record<string, never>, string>("server_local_home", {});
}

export async function serverLocalList(path: string, showHidden: boolean): Promise<SftpEntry[]> {
  return await invokeCommand<{ path: string; showHidden: boolean }, SftpEntry[]>(
    "server_local_list",
    { path, showHidden }
  );
}

export async function serverLocalMkdir(path: string): Promise<void> {
  return await invokeCommand<{ path: string }, void>("server_local_mkdir", { path });
}

export async function serverLocalRename(from: string, to: string): Promise<void> {
  return await invokeCommand<{ from: string; to: string }, void>("server_local_rename", {
    from,
    to,
  });
}

export async function serverLocalDelete(path: string, isDir: boolean): Promise<void> {
  return await invokeCommand<{ path: string; isDir: boolean }, void>("server_local_delete", {
    path,
    isDir,
  });
}

// Transfers.

/** Returns one transfer id per top-level source. */
export async function serverTransferStart(
  profileId: string,
  direction: TransferDirection,
  sources: string[],
  targetDir: string,
  conflictPolicy: ConflictPolicy
): Promise<string[]> {
  return await invokeCommand<
    {
      profileId: string;
      direction: TransferDirection;
      sources: string[];
      targetDir: string;
      conflictPolicy: ConflictPolicy;
    },
    string[]
  >("server_transfer_start", { profileId, direction, sources, targetDir, conflictPolicy });
}

export async function serverTransferPause(transferId: string): Promise<void> {
  return await invokeCommand<{ transferId: string }, void>("server_transfer_pause", {
    transferId,
  });
}

export async function serverTransferResume(transferId: string): Promise<void> {
  return await invokeCommand<{ transferId: string }, void>("server_transfer_resume", {
    transferId,
  });
}

export async function serverTransferCancel(transferId: string): Promise<void> {
  return await invokeCommand<{ transferId: string }, void>("server_transfer_cancel", {
    transferId,
  });
}

export async function serverTransferList(): Promise<TransferSnapshot[]> {
  return await invokeCommand<Record<string, never>, TransferSnapshot[]>("server_transfer_list", {});
}

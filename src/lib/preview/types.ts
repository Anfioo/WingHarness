import type { LoadState } from "./viewers/previewTypes";

/**
 * The shapes the viewer registry speaks.
 *
 * Lifted from the reference viewer's own `types.ts`, trimmed to what the
 * preview page needs: a payload to render, the metadata a preview can be
 * requested from, and the descriptor a viewer is registered as.
 */

export type FilePayload = {
  path: string;
  name: string;
  extension?: string;
  mime: string;
  size: number;
  modified?: number;
  created?: number;
  bytes: Uint8Array;
};

export type ViewerDescriptor = {
  id: string;
  label: string;
  extensions: readonly string[];
  editable: boolean;
  load: (payload: FilePayload) => Promise<LoadState>;
  loadUrl?: (payload: UrlPayload) => Promise<LoadState>;
};

export type FileMetadata = Omit<FilePayload, "bytes">;
export type UrlPayload = FileMetadata & { url: string; signal?: AbortSignal };

export type OpenTab = {
  path: string;
  name: string;
  viewerId: string;
};

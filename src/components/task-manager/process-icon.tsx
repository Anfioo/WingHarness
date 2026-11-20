// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// A process's executable icon. The sampler caches each executable's PNG once
// and hands out an id; this component fetches that PNG lazily and keeps the
// data URL for the rest of the page's life, so a virtualized table does not
// ask again as rows scroll back into view.

import { useEffect, useState } from "react";
import { argusIcon, type ProcessRow } from "@/commands";

type IconSource = Pick<ProcessRow, "icon" | "path" | "webView">;

/** Data URLs by icon id; ids are stable while the page is mounted. */
const resolved = new Map<number, string>();
/** Requests in flight, so two rows with the same icon ask only once. */
const pending = new Map<number, Promise<string | null>>();

function loadIcon(id: number): Promise<string | null> {
  const cached = resolved.get(id);
  if (cached) return Promise.resolve(cached);
  const running = pending.get(id);
  if (running) return running;
  const request = argusIcon(id)
    .catch(() => null)
    .then((url) => {
      pending.delete(id);
      if (url) resolved.set(id, url);
      return url;
    });
  pending.set(id, request);
  return request;
}

function GenericAppIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="text-muted-foreground shrink-0"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" />
      <path d="M1.5 5.5h13" stroke="currentColor" />
      <circle cx="3.6" cy="4" r="0.55" fill="currentColor" />
      <circle cx="5.3" cy="4" r="0.55" fill="currentColor" />
    </svg>
  );
}

/** Fallback for kernel pseudo-processes (System, Registry, Memory Compression). */
function KernelIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="text-muted-foreground shrink-0"
    >
      <rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" />
      <rect x="5.5" y="5.5" width="5" height="5" rx="1" fill="currentColor" />
      <path
        d="M6 1.5V3M10 1.5V3M6 13v1.5M10 13v1.5M1.5 6H3M1.5 10H3M13 6h1.5M13 10h1.5"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ProcessIcon({ process, size = 16 }: { process: IconSource; size?: number }) {
  // A WebView2 helper shows the icon of the app that hosts it.
  const id = process.webView?.hostIcon ?? process.icon;
  const [src, setSrc] = useState<string | null>(() =>
    id === null ? null : (resolved.get(id) ?? null)
  );

  useEffect(() => {
    if (id === null) {
      setSrc(null);
      return;
    }
    const cached = resolved.get(id);
    if (cached) {
      setSrc(cached);
      return;
    }
    let active = true;
    setSrc(null);
    void loadIcon(id).then((url) => {
      if (active) setSrc(url);
    });
    return () => {
      active = false;
    };
  }, [id]);

  if (src) {
    return (
      <img
        src={src}
        width={size}
        height={size}
        alt=""
        draggable={false}
        className="shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  // No image path means a kernel pseudo-process, not an app without metadata.
  return process.path === null ? <KernelIcon size={size} /> : <GenericAppIcon size={size} />;
}

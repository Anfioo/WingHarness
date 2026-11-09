// The reusable preview host: embedded in a page or a codelet tab, or filling
// the standalone preview window.
//
// A0 ships the frozen props and an empty shell. F2 replaces the body with the
// toolbar and the viewer dispatcher; callers already depend on this signature.

import type { ReactElement } from "react";

/** The file the host should show. */
export interface PreviewTarget {
  path: string;
  name: string;
  size?: number;
  etag?: string;
}

export interface PreviewHostProps {
  mode: "embedded" | "window";
  target: PreviewTarget | null;
  onClose?: () => void;
  onEdited?: (next: PreviewTarget) => void;
  className?: string;
}

export function PreviewHost(props: PreviewHostProps): ReactElement {
  void props;
  return <div className="sp-preview" />;
}

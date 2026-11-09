// The standalone preview window.
//
// The window is declared hidden by `tauri.conf.json` and shown by the space
// agent. A0 ships the empty shell; F3 fills in the selection handling and F2
// the viewer itself.

import { PreviewHost } from "@/components/space-preview/host";

export default function PreviewWindow() {
  return (
    <div className="h-screen w-screen overflow-hidden">
      <PreviewHost mode="window" target={null} />
    </div>
  );
}

// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useMoinTasks } from "@/hooks/use-moin-tasks";
import DownloadsTab from "./downloads-tab";

/**
 * Page shell: the shared download snapshot and nothing else.
 *
 * The download events are subscribed here (through `useMoinTasks`) rather than
 * in the view, so the list never drops a task update. `AppShell` is already
 * applied by `RoutedApp` for this route, so the page must not wrap itself in
 * another one.
 *
 * Categories are not a view of their own: they are managed from the filter
 * row's 分类 menu (`CategoryManagerDialog`), which keeps one list, one editor
 * and one delete confirmation for both the filter and the manager.
 */
export default function MoinPage() {
  const downloads = useMoinTasks();

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
      <DownloadsTab
        tasks={downloads.tasks}
        progress={downloads.progress}
        loading={downloads.loading}
        error={downloads.error}
        reload={downloads.reload}
      />
    </div>
  );
}

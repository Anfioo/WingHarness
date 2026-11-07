// The project page's table tab: the shared table editor with the project's own
// row limit.
//
// A table is opened by double-clicking it in the object tree, and it lives in
// the editor area rather than in the results dock, so it keeps the full
// toolbar — paging, filtering, drafts, import and export.

import type { ReactNode } from "react";
import { toast } from "sonner";
import { TableEditor } from "@/pages/database/table-editor";
import { useProjectDb, type ProjectDbTab } from "@/features/database/project/view-store";

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectTableTab({ tab }: { tab: ProjectDbTab }): ReactNode {
  const pageSize = useProjectDb((state) => state.settings.tablePageSize);
  const setTablePageSize = useProjectDb((state) => state.setTablePageSize);

  if (tab.kind !== "table") return null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <TableEditor
        target={tab.target}
        schema={tab.schema}
        table={tab.table}
        pageSize={pageSize}
        onPageSizeChange={(size) => {
          setTablePageSize(size).catch((error: unknown) => toast.error(failureText(error)));
        }}
      />
    </div>
  );
}

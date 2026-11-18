import { AppShell } from "@/components/app-shell";
import { TaskManagerApp } from "./task-manager-app";

/** The task manager page of the main window. */
export default function TaskManagerPage() {
  return (
    <AppShell>
      <TaskManagerApp />
    </AppShell>
  );
}

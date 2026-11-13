/** A label/value line used by the install summary and the overview cards. */
export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-baseline">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-xs break-all">{value || "—"}</span>
    </div>
  );
}

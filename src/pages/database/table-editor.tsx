export type TableEditorProps = { target: string; schema: string; table: string };

export function TableEditor(_props: TableEditorProps) {
  // The props are the frozen interface; the body is a stub.
  void _props;
  return <div className="text-muted-foreground p-3 text-sm">Table editor</div>;
}

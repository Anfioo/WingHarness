import type { QueryResult } from "@/commands";

export type ResultViewProps = {
  result: QueryResult;
  editable?: boolean;
  paging?: { page: number; pageSize: number; hasMore: boolean; onPage: (page: number) => void };
};

export function ResultView(_props: ResultViewProps) {
  // The props are the frozen interface; the body is a stub.
  void _props;
  return null;
}

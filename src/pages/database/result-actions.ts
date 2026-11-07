// The actions a result tab offers: run a statement again, fetch another page,
// count the rows. A stub for now; the data-view track fills it in.

export async function rerunResult(key: string, resultId: number): Promise<void> {
  void key;
  void resultId;
}

export async function loadResultPage(
  key: string,
  resultId: number,
  page: number,
  pageSize: number
): Promise<void> {
  void key;
  void resultId;
  void page;
  void pageSize;
}

export async function countResult(key: string, resultId: number): Promise<void> {
  void key;
  void resultId;
}

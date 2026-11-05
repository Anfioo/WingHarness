import i18n from "@/i18n";

export interface FetchResult {
  succeeded: string[];
  failed: { name: string; error: string }[];
}

export async function fetchRemotes(
  names: string[],
  fetchOne: (name: string) => Promise<unknown>
): Promise<FetchResult> {
  const result: FetchResult = { succeeded: [], failed: [] };
  for (const name of names) {
    try {
      await fetchOne(name);
      result.succeeded.push(name);
    } catch (error) {
      result.failed.push({
        name,
        error: (error as { message?: string })?.message ?? String(error),
      });
    }
  }
  return result;
}

export function fetchResultMessage(result: FetchResult): string {
  const total = result.succeeded.length + result.failed.length;
  if (total === 0) return i18n.t("gitRepo.sidebar.fetch.none");
  if (result.failed.length === 0) {
    return total === 1
      ? i18n.t("gitRepo.sidebar.fetch.one")
      : i18n.t("gitRepo.sidebar.fetch.all", { count: total });
  }
  const failures = result.failed.map(({ name, error }) => `${name}: ${error}`).join("; ");
  return i18n.t("gitRepo.sidebar.fetch.partial", {
    succeeded: result.succeeded.length,
    total,
    failures,
  });
}

export function fileFilterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesFileFilter(path: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = path.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterFiles<T>(items: T[], pathOf: (item: T) => string, query: string): T[] {
  const terms = fileFilterTerms(query);
  if (terms.length === 0) return items;
  return items.filter((item) => matchesFileFilter(pathOf(item), terms));
}

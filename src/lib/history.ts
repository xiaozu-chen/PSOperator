const KEY = "psoperator.history";
const MAX = 500;

export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function pushHistory(list: string[], entry: string): string[] {
  if (list[list.length - 1] === entry) return list;
  const next = [...list, entry].slice(-MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: history just won't persist */
  }
  return next;
}

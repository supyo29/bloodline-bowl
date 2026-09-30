/** Minimal RFC-4180-ish CSV reader (each repo read adapter carries its own; this one is scoped to lib/role-calibration). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []; let cur: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { cur.push(f); f = ""; }
    else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f.length || cur.length) { cur.push(f); rows.push(cur); }
  const [head, ...body] = rows.filter((r) => r.length > 1 || (r[0] ?? "") !== "");
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
export const num = (v: string | undefined): number | null => (v == null || v === "" || v === "NA" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export const str = (v: string | undefined): string | null => (v == null || v === "" || v === "NA" ? null : v);

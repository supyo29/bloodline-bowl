import { writeFileSync } from "node:fs";
import { assertLocalOnly } from "./guard";

assertLocalOnly();
export const URL_ = process.env.SUPABASE_URL!;
export const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const ANON = process.env.LOCAL_ANON_KEY!;
export const DB = process.env.LOCAL_DB_CONTAINER!;

export interface Result { id: string; area: string; name: string; status: "PASS" | "FAIL" | "INFO" | "BLOCKED" | "FINDING"; detail?: unknown }
export const results: Result[] = [];
export async function check(area: string, name: string, fn: () => Promise<{ ok: boolean; detail?: unknown } | boolean | void>): Promise<void> {
  const id = `${area}.${results.filter((r) => r.area === area).length + 1}`;
  try {
    const r = await fn();
    const ok = r === undefined ? true : typeof r === "boolean" ? r : r.ok;
    const detail = r && typeof r === "object" ? r.detail : undefined;
    results.push({ id, area, name, status: ok ? "PASS" : "FAIL", detail });
  } catch (e) {
    results.push({ id, area, name, status: "FAIL", detail: e instanceof Error ? e.message.slice(0, 300) : String(e) });
  }
  const r = results[results.length - 1]!;
  console.log(`${r.status.padEnd(7)} ${r.id.padEnd(8)} ${name}${r.status === "FAIL" ? `   <-- ${JSON.stringify(r.detail)}` : ""}`);
}
/** A characterized, documented finding that is NOT a failed check: reported with a severity, never aborts the run. If the condition does not hold it is a PASS. */
export async function finding(area: string, name: string, severity: "P0" | "P1" | "P2" | "P3", fn: () => Promise<{ ok: boolean; detail?: unknown }>): Promise<void> {
  const id = `${area}.${results.filter((r) => r.area === area).length + 1}`;
  let ok = false; let detail: unknown;
  try { const r = await fn(); ok = r.ok; detail = r.detail; } catch (e) { detail = e instanceof Error ? e.message.slice(0, 300) : String(e); }
  results.push({ id, area, name: `[${severity}] ${name}`, status: ok ? "PASS" : "FINDING", detail });
  console.log(`${(ok ? "PASS" : "FINDING").padEnd(7)} ${id.padEnd(8)} [${severity}] ${name}`);
}
export const info = (area: string, name: string, detail: unknown, status: Result["status"] = "INFO"): void => {
  results.push({ id: `${area}.${results.filter((r) => r.area === area).length + 1}`, area, name, status, detail });
  console.log(`${status.padEnd(7)} ${area.padEnd(8)} ${name} ${status === "FAIL" ? JSON.stringify(detail) : ""}`);
};
export function finish(file: string): void {
  writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), target: URL_, results }, null, 1));
  const c = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\nSUMMARY pass=${c("PASS")} fail=${c("FAIL")} finding=${c("FINDING")} blocked=${c("BLOCKED")} info=${c("INFO")} -> ${file}`);
  process.exit(c("FAIL") ? 1 : 0);
}

const hdr = (key: string, extra: Record<string, string> = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra });
export async function rest(path: string, o: { method?: string; key?: string; body?: unknown; prefer?: string } = {}): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { method: o.method ?? "GET", headers: hdr(o.key ?? KEY, o.prefer ? { Prefer: o.prefer } : {}), body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}

/** SQL straight into the LOCAL Postgres container (the PostgreSQL half of "PostgreSQL and PostgREST assertions"). */
import { execFileSync } from "node:child_process";
export function sql(q: string, db = "postgres"): string {
  return execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-d", db, "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
}

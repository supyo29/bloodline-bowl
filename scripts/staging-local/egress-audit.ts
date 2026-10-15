/**
 * EGRESS AUDIT (local Docker Supabase only): wraps global fetch, runs a REAL capture, and tabulates every outbound request by host and HTTP method.
 * Requirement: provider calls are read-only (GET), the only non-GET traffic is to the LOCAL PostgREST, and nothing reaches a hosted Supabase.
 */
import { check, finish, info } from "./lib";
import { runScheduledRoleShadowCapture } from "../../lib/persistence/supabase/role-shadow-runtime";

const tally = new Map<string, number>();
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const k = `${method} ${url.protocol}//${url.host}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
  return real(input as never, init);
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.ROLE_SHADOW_CAPTURE = "1";
  const run = await runScheduledRoleShadowCapture({ env: process.env });
  const rows = [...tally.entries()].sort();
  info("E", "outbound requests during one real capture run (method host = count)", Object.fromEntries(rows));
  const hosts = new Set(rows.map(([k]) => k.split(" ")[1]!));
  await check("E", "the capture run itself succeeded (OK, 0 failures)", async () => ({ ok: run.status === "OK" && run.failures === 0, detail: { status: run.status, by_status: run.totals.by_status } }));
  await check("E", "NO FANTASY-PROVIDER MUTATION: every request to a non-local host is a GET", async () => {
    const bad = rows.filter(([k]) => !k.includes("127.0.0.1") && !k.startsWith("GET "));
    return { ok: bad.length === 0, detail: { non_get_external: bad, external_hosts: [...hosts].filter((h) => !h.includes("127.0.0.1")) } };
  });
  await check("E", "non-GET traffic goes ONLY to the local PostgREST (127.0.0.1:54321)", async () => {
    const bad = rows.filter(([k]) => !k.startsWith("GET ") && !k.endsWith("http://127.0.0.1:54321"));
    return { ok: bad.length === 0, detail: { non_get: rows.filter(([k]) => !k.startsWith("GET ")) } };
  });
  await check("E", "NOTHING reached a hosted Supabase or any *.supabase.co host", async () => ({ ok: ![...hosts].some((h) => /supabase\.(co|com)/.test(h)), detail: { hosts: [...hosts] } }));
  await check("E", "no Yahoo endpoint was contacted (no OAuth exists locally; Yahoo leagues were skipped by design)", async () => ({ ok: ![...hosts].some((h) => /yahoo/i.test(h)), detail: { hosts: [...hosts] } }));
  finish("docs/evidence/w2p2-local-staging-egress.json");
}
main().catch((e) => { console.error(e); process.exit(2); });

/** Yahoo keep-alive job body (see app/api/cron/yahoo-health). Credential-free results; read-only against Yahoo. */
import { loadYahooConfig } from "./config";
import { listYahooConnectionBindings } from "./connections";
import { getYahooConnectionHealth, type YahooConnectionHealth } from "./health";
import { getValidAccessToken, recordYahooAuthenticatedRead, type YahooTokenStore } from "./oauth";
import { YahooFantasyClient } from "./client";
import { verifyAuthenticatedAccess } from "./discovery";
import { resolveYahooTokenStore } from "./token-store";

/** Refresh in the job only when the access token has < 30 min left (access tokens last 60 min) — never unconditionally. */
export const HEALTH_JOB_REFRESH_WINDOW_MS = 30 * 60_000;

export interface YahooHealthJobResult { connection_id: string; ok: boolean; refreshed_by_job: boolean; probe: "OK" | "FAILED" | "SKIPPED"; health: YahooConnectionHealth | null; detail: string }

export async function runYahooHealthJob(deps: { store?: (connectionId: string) => YahooTokenStore | null; fetchImpl?: typeof fetch; connections?: string[] } = {}): Promise<YahooHealthJobResult[]> {
  const cfg = loadYahooConfig();
  const ids = deps.connections ?? listYahooConnectionBindings().map((b) => b.connection_id);
  const out: YahooHealthJobResult[] = [];
  for (const id of ids) {
    const store = deps.store ? deps.store(id) : (() => { const r = resolveYahooTokenStore(process.env, { connectionId: id }); return r.ok ? r.store : null; })();
    if (!store) { out.push({ connection_id: id, ok: false, refreshed_by_job: false, probe: "SKIPPED", health: null, detail: "No durable token store." }); continue; }
    if (!cfg.configured || !cfg.config) { out.push({ connection_id: id, ok: false, refreshed_by_job: false, probe: "SKIPPED", health: null, detail: "Yahoo OAuth is not configured." }); continue; }
    const before = (await store.getVersioned?.())?.seq ?? null;
    const tok = await getValidAccessToken(cfg.config, store, { skewMs: HEALTH_JOB_REFRESH_WINDOW_MS, fetchImpl: deps.fetchImpl });
    const after = (await store.getVersioned?.())?.seq ?? null;
    if (tok.status !== "OK") { out.push({ connection_id: id, ok: false, refreshed_by_job: false, probe: "SKIPPED", health: await getYahooConnectionHealth(id, store), detail: tok.status === "NOT_CONNECTED" ? "Not connected." : `Token unavailable (${tok.failure_kind ?? "unknown"}).` }); continue; }
    let probe: "OK" | "FAILED" = "FAILED";
    try {
      const client = new YahooFantasyClient({ config: cfg.config, store, fetchImpl: deps.fetchImpl });
      probe = (await verifyAuthenticatedAccess(client)).ok ? "OK" : "FAILED";
    } catch { probe = "FAILED"; }
    if (probe === "OK") { recordYahooAuthenticatedRead(id); await store.markUsed?.(); }
    out.push({ connection_id: id, ok: probe === "OK", refreshed_by_job: before != null && after != null && after > before, probe, health: await getYahooConnectionHealth(id, store), detail: probe === "OK" ? "Authenticated read succeeded." : "Authenticated Yahoo probe failed." });
  }
  return out;
}

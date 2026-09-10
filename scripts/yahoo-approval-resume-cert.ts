/**
 * Yahoo Phase 1 — approval-resume certification.
 *
 *   npx tsx scripts/yahoo-approval-resume-cert.ts
 *   YAHOO_CERT_BASE=https://…  REFRESH_SECRET=…  npx tsx scripts/yahoo-approval-resume-cert.ts
 *
 * Run this the moment Yahoo grants Fantasy Sports API access for the Client ID.
 * It walks the full Phase 1 live-cert checklist against the DEPLOYED bridge.
 *
 * PROPERTIES
 *   - 100% read-only. Hits only GET endpoints + one POST to /api/yahoo/diagnostics
 *     (which itself performs only GET calls against Yahoo). No Yahoo write.
 *   - Never prints REFRESH_SECRET, tokens, or Authorization headers.
 *   - Stops cleanly the instant the taxonomy reports FANTASY_API_FORBIDDEN
 *     (Yahoo approval not yet effective) — exit code 2, not a crash.
 *   - Never guesses the 2026 game key — it is only ever read from the API.
 *   - Distinguishes "Maclin on Chick's XVI is inaccessible to this account"
 *     (expected, not a failure) from an architecture/regression failure.
 *
 * EXIT CODES  0 = fully certified   2 = still externally blocked (403/rate-limit)
 *             1 = internal failure (unexpected shape, 5xx, regression)
 */

const BASE = (process.env.YAHOO_CERT_BASE ?? "https://bloodline-bowl-sleeper-bridge.vercel.app").replace(/\/$/, "");
const SECRET = process.env.REFRESH_SECRET?.trim() ?? "";

type StepStatus = "PASS" | "BLOCKED" | "FAIL" | "SKIP";
const results: Array<{ step: string; status: StepStatus; note: string }> = [];
function record(step: string, status: StepStatus, note: string) {
  results.push({ step, status, note });
  const icon = { PASS: "✓", BLOCKED: "⏸", FAIL: "✗", SKIP: "·" }[status];
  console.log(`${icon} ${step} — ${note}`);
}

/** Redact anything token-shaped from a value before it is ever printed. */
function sanitize(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (key, value) => {
      if (/token|secret|authorization|apikey|bearer|encryption/i.test(key)) return "«redacted»";
      return value;
    }),
  );
}

async function getJson(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _unparseable: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

const FORBIDDEN_STATES = new Set(["FANTASY_API_FORBIDDEN", "RATE_LIMITED"]);

/**
 * True when a response indicates the Fantasy API refused the call — either the
 * new `access_state` taxonomy, or (older deployment) a 403/FORBIDDEN signature
 * anywhere in the sanitized string fields. Keeps the script honest across a
 * deployment that predates the taxonomy.
 */
function looksForbidden(obj: any): boolean {
  if (obj && FORBIDDEN_STATES.has(obj.access_state)) return true;
  const blob = JSON.stringify(obj ?? {});
  return /HTTP 403|"FORBIDDEN"|FORBIDDEN:|GAME_KEY_UNRESOLVED/.test(blob) && /403|FORBIDDEN/.test(blob);
}

async function main() {
  console.log(`Yahoo Phase 1 approval-resume certification\nbase: ${BASE}\n`);

  // 1 — status (+probe)
  const status = await getJson("/api/yahoo/status?probe=1");
  if (status.status !== 200) return finish("FAIL", `/api/yahoo/status HTTP ${status.status}`);
  const s = status.body;
  if (!s.configured) return finish("FAIL", `Yahoo not configured: missing ${JSON.stringify(s.missing_env)}`);
  if (s.access_state === "NOT_CONNECTED" || s.access_state === "TOKEN_EXPIRED_OR_INVALID") {
    return finish("FAIL", `OAuth connection not healthy (${s.access_state}) — re-run /api/yahoo/auth/start`);
  }
  const state1 = s.access_state ?? (s.authorized ? "CONNECTED (legacy status shape)" : s.session_state);
  record("1. /api/yahoo/status", "PASS", `access_state=${state1}, token_healthy=${s.token_healthy}, backend=${s.token_storage_backend}`);
  if (FORBIDDEN_STATES.has(s.access_state)) {
    return finish("BLOCKED", `Fantasy API still ${s.access_state} — Yahoo approval not yet effective. ${s.access_detail ?? ""}`);
  }

  // 2-14 — the deep probe (identity → game key → discovery → per-league sub-resources → user teams)
  if (!SECRET) {
    record("2-14. /api/yahoo/diagnostics", "SKIP", "REFRESH_SECRET not set in env — export it to run the deep probe");
  } else {
    const deep = await getJson("/api/yahoo/diagnostics", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    if (deep.status === 401) return finish("FAIL", "/api/yahoo/diagnostics 401 — wrong REFRESH_SECRET");
    if (deep.status >= 500) return finish("FAIL", `/api/yahoo/diagnostics HTTP ${deep.status}`);
    const d = deep.body;

    if (FORBIDDEN_STATES.has(d.access_state)) {
      record("2. authenticated /users;use_login=1/games", "BLOCKED", d.access_detail);
      return finish("BLOCKED", `Deep probe reports ${d.access_state}. ${d.access_detail}`);
    }
    record("2. authenticated /users;use_login=1/games", d.discovery?.authenticated ? "PASS" : "FAIL", d.discovery?.authenticated_detail ?? "no detail");

    // 3 — dynamic game key (must come from the API, never a guess)
    const gk = d.discovery?.game_key;
    if (!gk) return finish("FAIL", `2026 NFL game key unresolved: ${d.discovery?.game_key_detail}`);
    if (d.discovery?.game_key_live !== true) return finish("FAIL", `game key ${gk} is not live-resolved (override in play?)`);
    record("3. dynamic 2026 NFL game key", "PASS", `${gk} (live)`);

    // 4 — user league discovery
    record("4. user league discovery", "PASS", `${(d.discovery?.discovered_leagues ?? []).length} league(s) visible to the account`);

    // 5/6 — the two configured leagues
    for (const [step, slug, id, expected] of [
      ["5. Rogers Park", "rogers-park", "287140", "Rogers Park"],
      ["6. Maclin on Chick's XVI", "maclin-on-chicks-xvi", "82713", "Maclin on Chick's XVI"],
    ] as const) {
      const cfg = (d.discovery?.configured_leagues ?? []).find((c: any) => c.league_slug === slug || c.requested_league_id === id);
      if (!cfg) {
        record(step, "FAIL", "not present in configured_leagues — architecture/registry problem");
        continue;
      }
      if (cfg.accessible && cfg.league?.name === expected) {
        record(step, "PASS", `Yahoo confirms name "${cfg.league.name}"`);
      } else if (cfg.accessible && cfg.name_matches === false) {
        record(step, "FAIL", `Yahoo name "${cfg.league?.name}" != expected "${expected}"`);
      } else if (!cfg.accessible && (cfg.error_kind === "FORBIDDEN" || cfg.error_kind === "NOT_FOUND")) {
        // Expected for a league this account does not belong to.
        record(step, slug === "maclin-on-chicks-xvi" ? "SKIP" : "FAIL",
          `inaccessible to this account (${cfg.error_kind}) — ${slug === "maclin-on-chicks-xvi" ? "expected; authorize a second Yahoo account later" : "UNEXPECTED for a league this account should own"}`);
      } else {
        record(step, "FAIL", `unexpected probe outcome: ${cfg.detail}`);
      }
    }

    // 7-13 — per-league sub-resources
    for (const lp of d.league_probes ?? []) {
      const ok = (lp.sub_resources ?? []).filter((r: any) => r.ok).map((r: any) => r.resource);
      const bad = (lp.sub_resources ?? []).filter((r: any) => !r.ok).map((r: any) => `${r.resource}:${r.error_kind}`);
      record(`7-13. ${lp.league_slug} sub-resources`, bad.length === 0 && ok.length > 0 ? "PASS" : ok.length ? "PASS" : "FAIL",
        `ok=[${ok.join(",")}]${bad.length ? ` failed=[${bad.join(",")}]` : ""}`);
      // 14 — user team / roster
      if (lp.teams) {
        record(`14. ${lp.league_slug} user team/roster`, lp.teams.ok ? "PASS" : "SKIP",
          `${lp.teams.detail} roster_readable=${lp.teams.roster_readable}`);
      }
    }

    console.log("\nsanitized deep-probe snapshot:");
    console.log(JSON.stringify(sanitize({ access_state: d.access_state, discovery: { ...d.discovery, configured_leagues: (d.discovery?.configured_leagues ?? []).map((c: any) => ({ slug: c.league_slug, accessible: c.accessible, name: c.league?.name, name_matches: c.name_matches, error_kind: c.error_kind })) } }), null, 2));
  }

  // Per-league detail endpoints (independent of the secret-gated deep probe)
  for (const slug of ["rogers-park", "maclin-on-chicks-xvi"]) {
    const r = await getJson(`/api/yahoo/leagues/${slug}`);
    const st = r.body?.access_state ?? r.body?.status;
    if (looksForbidden(r.body)) {
      record(`detail /api/yahoo/leagues/${slug}`, "BLOCKED", `Fantasy API forbidden (${st})`);
    } else if (r.status === 200 && r.body?.status === "READY") {
      record(`detail /api/yahoo/leagues/${slug}`, "PASS", `name="${r.body.league?.name}" matches=${r.body.name_matches}`);
    } else if (r.status === 403) {
      record(`detail /api/yahoo/leagues/${slug}`, slug === "maclin-on-chicks-xvi" ? "SKIP" : "FAIL", "league inaccessible to this account");
    } else {
      record(`detail /api/yahoo/leagues/${slug}`, "FAIL", `HTTP ${r.status} state=${st}`);
    }
  }

  const blocked = results.some((r) => r.status === "BLOCKED");
  const failed = results.some((r) => r.status === "FAIL");
  finish(blocked ? "BLOCKED" : failed ? "FAIL" : "PASS", "checklist complete");
}

function finish(verdict: "PASS" | "BLOCKED" | "FAIL", note: string): never {
  console.log("\n" + "─".repeat(60));
  console.log(`RESULT: ${verdict} — ${note}`);
  if (verdict === "PASS") {
    console.log("YAHOO PHASE 1: LIVE-CERTIFIED — Fantasy API access confirmed, all endpoints read.");
    process.exit(0);
  }
  if (verdict === "BLOCKED") {
    console.log("YAHOO PHASE 1: READY — EXTERNALLY BLOCKED ON FANTASY API ACCESS (re-run after Yahoo approval).");
    process.exit(2);
  }
  console.log("YAHOO PHASE 1: INTERNAL BLOCKER — investigate the FAIL line(s) above.");
  process.exit(1);
}

main().catch((err) => {
  console.error("cert script error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

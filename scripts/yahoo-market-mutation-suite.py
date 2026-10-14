#!/usr/bin/env python3
"""Yahoo Market State mutation suite. One source mutation at a time; KILLED when a test that passes on the unmutated tree fails; files are restored byte-for-byte
(hash-checked). Proves the Yahoo Market State tests can actually fail when a guard is weakened. Do NOT edit files while this runs.
Usage: python3 scripts/yahoo-market-mutation-suite.py [Y1 Y5 ...]"""
import hashlib, subprocess, sys, json
TESTS = ["test/yahoo-market-state-build.test.ts", "test/yahoo-market-state-load.test.ts", "test/yahoo-market-state-weekly.test.ts", "test/yahoo-sleeper-bridge.test.ts",
         "test/yahoo-market-parsers.test.ts", "test/yahoo-readonly-auth.test.ts", "test/yahoo-market-architecture.test.ts", "test/yahoo-players.test.ts", "test/yahoo-fetch.test.ts", "test/market-state-adversarial.test.ts"]
BUILD, LOAD, INT = "lib/market-state/yahoo-build.ts", "lib/market-state/yahoo-load.ts", "lib/market-state/integrity.ts"
PLY, CLIENT, DISC, PEND = "lib/providers/yahoo/players.ts", "lib/providers/yahoo/client.ts", "lib/providers/yahoo/discovery.ts", "lib/providers/yahoo/pending-claims.ts"
ADAPT, REPL, W2 = "lib/weekly/market-pool-adapter.ts", "lib/weekly/replacement.ts", "lib/waiver2/market-pool.ts"
BR, CW = "lib/canonical/yahoo-sleeper-bridge.ts", "lib/canonical/players.ts"
MUT = [
 # ---- the twelve the brief names ----
 ("Y1", "UNROSTERED => FREE AGENT: every pool row the provider did not mark FA is treated as FA (waiver / unverified players become addable)", BUILD, [('    if (r0.status === "FA") {', '    if (true as boolean) {')]),
 ("Y1b", "UNROSTERED => FREE AGENT at the engine: a projected unrostered player Yahoo did not verify stays a free agent", ADAPT, [('if (!m) return { ...ap, ownership: "locked_ineligible", unresolved_note: "unrostered, but not verified available by Yahoo\'s own free-agent / waiver status" };', 'if (!m) return ap;')]),
 ("Y2", "only the FIRST page of the player pool is fetched (the reader stops after one wave)", PLY, [('  while (pages < maxPages) {', '  while (pages < 1) {')]),
 ("Y2b", "the loader asks Yahoo for a single page (count: 25) instead of the whole pool", LOAD, [('pool: (h, code, deadlineMs) => fetchPlayerPool(h.client, h.leagueKey, { status: code, start: 0, count: null,', 'pool: (h, code, deadlineMs) => fetchPlayerPool(h.client, h.leagueKey, { status: code, start: 0, count: 25,')]),
 ("Y3", "one team's roster is omitted from the league-wide ownership read", LOAD, [('    const teams = teamsR.value; const out: YahooRosterTeam[] = [];', '    const teams = teamsR.value.slice(1); const out: YahooRosterTeam[] = [];')]),
 ("Y4", "Yahoo connections swapped (and the binding check removed): Maclin reads with Rogers Park's token and vice versa", LOAD, [('  const connection_id = target.yahoo_connection_id ?? DEFAULT_YAHOO_CONNECTION_ID;', '  const connection_id = target.yahoo_connection_id === "maclin" ? "primary" : "maclin";'), ('  if (!yahooLeaguesForConnection(connection_id).some((l) => l.key === slug)) return { ok: false, code: "yahoo_connection_league_mismatch", detail: `league "${slug}" is not bound to Yahoo connection "${connection_id}"` };', '')]),
 ("Y4b", "the handle returned by the provider is trusted even when it used another connection", LOAD, [('    if (r.data.connectionId !== b.connection_id) return', '    if (false as boolean) return')]),
 ("Y5", "UNKNOWN => FREE AGENT: an ambiguous / unresolvable defense is offered as available", BUILD, [('    if (id.defenseUnresolved || (id.entity === "PLAYER" && id.team && !isCanonicalTeam(id.team))) {', '    if (false as boolean) {')]),
 ("Y5b", "UNKNOWN => FREE AGENT: a player rostered on one team but listed FA by Yahoo is no longer a conflict", BUILD, [('    if (owner === "__CONFLICT__" || nonOwnedPool.length > 0) {', '    if (owner === "__CONFLICT__") {')]),
 ("Y6", "KICKERS are discarded (K is no longer a startable position)", BUILD, [('const YAHOO_BASE = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);', 'const YAHOO_BASE = new Set(["QB", "RB", "WR", "TE", "DEF"]);')]),
 ("Y7", "TEAM DEFENSES are discarded (DEF is no longer a startable position)", BUILD, [('const YAHOO_BASE = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);', 'const YAHOO_BASE = new Set(["QB", "RB", "WR", "TE", "K"]);')]),
 ("Y8", "the Yahoo key is used AS the Sleeper id (provider ids cross)", CW, [('        identifiers.sleeper_id = b.sleeper_id;', '        identifiers.sleeper_id = observed.provider_player_id ?? b.sleeper_id;')]),
 ("Y8b", "the weekly adapter matches Yahoo players on Sleeper id instead of canonical identity", ADAPT, [('const m = byCanon.get(ap.canonical_player_id);', 'const m = byCanon.get(String(ap.player.identifiers.sleeper_id ?? ""));')]),
 ("Y9", "stale market state is ignored (nothing is blocked however old)", BUILD, [('  if (stale.length) add({ code: "STALE_MARKET_STATE"', '  if (false as boolean) add({ code: "STALE_MARKET_STATE"')]),
 ("Y9b", "a cached read older than the staleness ceiling is re-stamped as live instead of re-read", LOAD, [('    if (nowMs - hit.fetchedAtMs < YAHOO_STALE_AFTER_MS && hit.fingerprint) {', '    if (hit.fingerprint) {')]),
 ("Y10", "the pool is blocked because pending claims are unavailable", BUILD, [('{ code: pc.visibility === "UNAVAILABLE" ? "PENDING_CLAIMS_UNAVAILABLE" : "PENDING_CLAIMS_NOT_EXPOSED", severity: "INFO"', '{ code: pc.visibility === "UNAVAILABLE" ? "PENDING_CLAIMS_UNAVAILABLE" : "PENDING_CLAIMS_NOT_EXPOSED", severity: "BLOCKING"')]),
 ("Y11", "the FULL player pool (not the verified available pool) sets replacement level", REPL, [('    if (ap.ownership === "free_agent" || ap.ownership === "waiver") poolFA[pos]!.push(wp.projected_points);', '    poolFA[pos]!.push(wp.projected_points);')]),
 ("Y12", "a non-GET request is permitted to Yahoo (POST)", CLIENT, [('        method: "GET",', '        method: "POST",')]),
 # ---- the defects found while building, as regression mutants ----
 ("Y13", "the pool deadline is computed from the injected clock but enforced against the real one (the first-run defect)", LOAD, [('  const deadline = Date.now() + (opts.poolTimeBudgetMs ?? YAHOO_POOL_TIME_BUDGET_MS);', '  const deadline = nowFn().getTime() + (opts.poolTimeBudgetMs ?? YAHOO_POOL_TIME_BUDGET_MS);')]),
 ("Y14", "a changed transaction feed no longer forces a re-read (cached raw reads re-stamped regardless)", LOAD, [('      if (fp && fp === hit.fingerprint) {', '      if (true as boolean) {')]),
 ("Y15", "rows Yahoo returned in an FA/W query while its ownership said 'team' are not counted as conflicts", BUILD, [('  conflicts += (sub.FA?.dropped_rostered ?? 0) + (sub.W?.dropped_rostered ?? 0);', '')]),
 ("Y16", "two teams listing one player resolve to whichever came last (no conflict)", BUILD, [('    ownerByKey.set(p.player_key, ownerByKey.has(p.player_key) && ownerByKey.get(p.player_key) !== t.team_id ? "__CONFLICT__" : t.team_id);', '    ownerByKey.set(p.player_key, t.team_id);')]),
 ("Y17", "the connected account's own pending claim is ignored (the same move is re-recommended)", BUILD, [('  if (pc.visibility === "AVAILABLE" && pc.entries.length > 0) {', '  if (false as boolean) {')]),
 ("Y18", "waiver-claim and free-agent acquisition methods are no longer distinguished", ADAPT, [('const method = m.status === "AVAILABLE_FREE_AGENT" ? "FREE_AGENT_ADD" as const : "WAIVER_CLAIM" as const;', 'const method = "FREE_AGENT_ADD" as const;')]),
 ("Y19", "an ambiguous Yahoo->Sleeper name match is accepted (first candidate wins)", BR, [('    if (hit && hit.size > 1) return { status: "AMBIGUOUS", candidates: [...hit].sort() };', '')]),
 ("Y20", "probeUserTeams reads Yahoo's nested team shape with the one-level merge (the latent 'owns no team' false negative)", DISC, [('const key = asString(mergeYahooEntity(unwrap(t, "team")).team_key);', 'const key = asString(mergeLeadingObjects(unwrap(t, "team")).team_key);')]),
 ("Y21", "a processed (non-pending) transaction is counted as a pending claim", PEND, [('        if (!t || t.status.toLowerCase() !== "pending") continue;', '        if (!t) continue;')]),
 ("Y22", "Waiver 2.0 matches Yahoo players on Sleeper id again (verified Yahoo players never reach the engine)", W2, [('  const yahoo = market.provider === "yahoo";', '  const yahoo = false as boolean;')]),
 ("Y23", "the integrity guard that forbids availability without provider evidence is removed", INT, [('    if (p.status === "AVAILABLE_FREE_AGENT" && (!ev || ev.basis !== "PROVIDER_STATUS" || ev.provider_status !== "FA")) bad("AVAILABLE_WITHOUT_PROVIDER_EVIDENCE"', '    if (false as boolean) bad("AVAILABLE_WITHOUT_PROVIDER_EVIDENCE"')]),
 ("Y24", "a waiver date is promoted to a fabricated instant", BUILD, [('players.push(mk(key, { status: "ON_WAIVERS", ownership: "UNROSTERED", acquisition: { status: "WAIVER", mechanism: "WAIVER_CLAIM" }, eligible_to_add: false, claimable: true, reason: "IN_WAIVER_WINDOW", availability_evidence: ev, waiver_clears_on: d, lock }, metaOf));', 'players.push(mk(key, { status: "ON_WAIVERS", ownership: "UNROSTERED", acquisition: { status: "WAIVER", mechanism: "WAIVER_CLAIM" }, eligible_to_add: false, claimable: true, reason: "IN_WAIVER_WINDOW", availability_evidence: ev, waiver_clears_on: d, waiver_clears_at: d ? `${d}T00:00:00.000Z` : null, lock }, metaOf));')]),
 ("Y25", "an incomplete pool is reported as complete (partial reads look like the whole pool)", LOAD, [('complete: r.value.complete, pages_fetched', 'complete: true, pages_fetched')]),
 ("Y26", "a failed roster read is silently treated as an empty roster (no PARTIAL signal)", LOAD, [('failed.length === 0 ? okSrc(settledAt()) : out.length === 0', 'true ? okSrc(settledAt()) : out.length === 0')]),
 ("Y28", "the roster-union vs Yahoo rostered-pool reconciliation no longer raises a conflict", BUILD, [('  if (comparable && recon.roster_only > tolerance) conflicts += recon.roster_only;', '')]),
 ("Y29", "the reconciliation compares against an INCOMPLETE rostered pool as if it were whole", BUILD, [('  const comparable = rostersComplete && haveT && sub.T!.complete;', '  const comparable = rostersComplete && haveT;')]),
 ("Y30", "the null-team fallback ignores another same-name player who HAS a team (could be the player Yahoo means)", BR, [('    if (np.withTeam.size > 0) return { status: "NONE" };', '')]),
 ("Y31", "the null-team fallback accepts several team-less same-name players (first wins)", BR, [('    if (np.noTeam.size > 1) return { status: "AMBIGUOUS", candidates: [...np.noTeam].sort() };', '')]),
 ("Y32", "read-only mode no longer rejects an expired token (it would send a stale token / fall through)", "lib/providers/yahoo/client.ts", [('    if (token.expires_at - Date.now() <= READ_ONLY_EXPIRY_MARGIN_MS) {\n      throw new YahooApiError("AUTH_REFRESH_REQUIRED_READ_ONLY"', '    if (false as boolean) {\n      throw new YahooApiError("AUTH_REFRESH_REQUIRED_READ_ONLY"')]),
 ("Y33", "read-only mode no longer maps a Yahoo 401 to AUTH_REFRESH_REQUIRED_READ_ONLY", "lib/providers/yahoo/client.ts", [("      if (attempt.error.httpStatus === 401) throw new YahooApiError(\"AUTH_REFRESH_REQUIRED_READ_ONLY\"", "      if (false as boolean) throw new YahooApiError(\"AUTH_REFRESH_REQUIRED_READ_ONLY\"")]),
 ("Y34", "the read-only token store accepts a write (a refresh could persist a rotated token)", "lib/providers/yahoo/read-only-auth.ts", [("  async set(): Promise<void> { this.writeAttempts += 1; throw new YahooReadOnlyViolation(\"set\"); }", "  async set(): Promise<void> { /* mutated: write allowed */ }")]),
 ("Y35", "the client ignores readOnly and takes the normal refresh path", "lib/providers/yahoo/client.ts", [("    if (this.#readOnly) return this.#getReadOnly<T>(url, path);\n", "")]),
 ("Y36", "the read-only provider no longer checks expiry (it hands out an expired token)", "lib/providers/yahoo/provider.ts", [("      if (t.expires_at - Date.now() <= READ_ONLY_EXPIRY_MARGIN_MS) return { ok: false", "      if (false as boolean) return { ok: false")]),
 ("Y27", "a rejected token / auth failure on the pool is swallowed as an empty pool that looks complete", LOAD, [('    if (r.status !== "fulfilled") { poolErrs.push(', '    if (r.status !== "fulfilled") { sub[code] = { returned: 0, complete: true, pages_fetched: 0, stopped_reason: "end_of_pool" }; poolErrs.push(')]),
]
EQUIVALENT = {"Y36": "the provider pre-check duplicates the client guard: with the pre-check removed the client throws the same AUTH_REFRESH_REQUIRED_READ_ONLY (mapped to the same degraded code) before any network request, so no observable behavior differs (defense in depth; the client guard is killed by Y32)"}
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
def run():
    r = subprocess.run(["node", "--import", "tsx", "--test", *TESTS], capture_output=True, text=True)
    return sorted({l.strip()[7:] for l in r.stdout.splitlines() if l.strip().startswith("not ok")})
def main():
    only = set(sys.argv[1:]); files = {m[2] for m in MUT}; before = {f: sha(f) for f in files}
    base = set(run()); print(json.dumps({"baseline_failing": len(base), "baseline_failing_names": sorted(base)[:5]}), flush=True); res = []
    for mid, desc, path, edits in MUT:
        if only and mid not in only: continue
        orig = open(path).read(); new = orig
        for a, b in edits:
            c = new.count(a)
            if c != 1: print(json.dumps({"id": mid, "error": f"anchor matched {c}x", "anchor": a[:80]}), flush=True); new = None; break
            new = new.replace(a, b)
        if new is None: res.append((mid, "ANCHOR_ERROR")); continue
        open(path, "w").write(new)
        try: n2 = run()
        finally: open(path, "w").write(orig)
        fresh = [x for x in n2 if x not in base]
        res.append((mid, "KILLED" if fresh else ("EQUIVALENT" if mid in EQUIVALENT else "SURVIVED")))
        print(json.dumps({"id": mid, "mutation": desc, "status": res[-1][1], "newly_failing": len(fresh), "killed_by": [x[:110] for x in fresh[:2]]}), flush=True)
    print(json.dumps({"restored_byte_for_byte": before == {f: sha(f) for f in files}, "killed": sum(1 for _, s in res if s == "KILLED"), "total": len(res), "equivalent": [m for m, s in res if s == "EQUIVALENT"], "survived": [m for m, s in res if s not in ("KILLED", "EQUIVALENT")]}))
main()

/** Configured-league scoring inputs for the ledger. Provider-independent: every registry league, whatever its provider. */
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import type { LeagueScoringInput } from "./case-builder";

export async function loadLeagueScoringInputs(): Promise<LeagueScoringInput[]> {
  const out: LeagueScoringInput[] = [];
  for (const t of listLeagueTargets()) {
    const status = leagueConfigStatus(t);
    if (status === "PROVIDER_UNIMPLEMENTED" || status === "NOT_CONFIGURED") { out.push({ league_slug: t.key, provider: t.provider, scoring_fingerprint: null, raw_scoring: null, note: `league config status ${status}` }); continue; }
    try {
      const st = await buildCanonicalLeagueState(t.key, { reportPersistence: false });
      const lg = st.snapshot?.league;
      if (lg?.scoring_fingerprint && lg.raw_scoring && Object.keys(lg.raw_scoring).length) out.push({ league_slug: t.key, provider: t.provider, scoring_fingerprint: lg.scoring_fingerprint, raw_scoring: lg.raw_scoring });
      else out.push({ league_slug: t.key, provider: t.provider, scoring_fingerprint: null, raw_scoring: null, note: "canonical league state produced no scoring settings" });
    } catch (e) {
      out.push({ league_slug: t.key, provider: t.provider, scoring_fingerprint: null, raw_scoring: null, note: `canonical league state failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}

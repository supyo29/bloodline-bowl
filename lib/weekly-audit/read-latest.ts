/**
 * Phase 9 — read-only lookup of the latest generated weekly audit for one (season, week). Lives outside the
 * evidence query layer (which may not reference persistence/a store directly — the same isolation rule Phase 7's
 * evidence loader follows) and outside lib/persistence (which stays a pure I/O adapter with no audit-shaped
 * business logic). This is the one function the evidence family for this surface imports.
 */
import { defaultWeeklyAuditRest, readLatestWeeklyAudit as readFromStore } from "@/lib/persistence/supabase/weekly-audit-store";
import type { WeeklyModelAudit } from "./contract";

export async function readLatestWeeklyAudit(season: number, week: number): Promise<WeeklyModelAudit | null> {
  const rest = defaultWeeklyAuditRest();
  if (!rest) return null;
  return readFromStore(rest, season, week).catch(() => null);
}

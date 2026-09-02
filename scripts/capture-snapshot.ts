/**
 * CLI wrapper around the reusable capture logic.
 *
 *   npx tsx scripts/capture-snapshot.ts <league-slug> [--type FINAL] [--transactions]
 *   npx tsx scripts/capture-snapshot.ts --all [--type MID_WEEK]
 *
 * All work lives in `lib/persistence/capture.ts`; this file only parses args.
 * A future Vercel Cron / API job calls the same functions.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment to
 * actually persist — otherwise it prints the PERSISTENCE_NOT_CONFIGURED state
 * and exits non-zero.
 */

import { captureLeagueState, syncLeagueTransactions } from "@/lib/persistence/capture";
import { listLeagueTargets } from "@/lib/leagues/registry";
import type { CaptureType } from "@/lib/persistence/types";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const withTransactions = args.includes("--transactions");
  const typeIdx = args.indexOf("--type");
  const captureType = (typeIdx >= 0 ? args[typeIdx + 1] : "AD_HOC") as CaptureType;

  const slugs = all
    ? listLeagueTargets().map((t) => t.key)
    : args.filter((a) => !a.startsWith("--") && a !== captureType);

  if (slugs.length === 0) {
    console.error("Usage: capture-snapshot.ts <league-slug> [--type FINAL] [--transactions] | --all");
    process.exit(1);
  }

  let failed = false;
  for (const slug of slugs) {
    const snap = await captureLeagueState(slug, { capture_type: captureType, trigger: "CLI" });
    console.log(
      `[snapshot] ${slug}: ${snap.snapshot_outcome} (week ${snap.week ?? "?"}, live=${snap.live_provider_status}, persistence=${snap.persistence_status})`,
    );
    for (const w of snap.warnings) console.log(`   ! ${w}`);
    if (!snap.ok) failed = true;

    if (withTransactions) {
      const sync = await syncLeagueTransactions(slug, { trigger: "CLI" });
      console.log(
        `[txn-sync] ${slug}: seen ${sync.seen}, inserted ${sync.inserted}, duplicates ${sync.duplicates} (persistence=${sync.persistence_status})`,
      );
      for (const w of sync.warnings) console.log(`   ! ${w}`);
      if (!sync.ok) failed = true;
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

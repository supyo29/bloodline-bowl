# Player-Scheme build certification reports (tracked copies)

These 12 small JSON files are the BUILD-TIME certification reports written by `analysis/player_scheme_intelligence/build_tier{A,B,C,D}.R` / `source_audit.R` into the **gitignored**
`outputs/player-scheme-intelligence-2026/`. The Player-Scheme tests assert on them (reconciliation `all_pass`, "no fabricated 2026", box-bucket verdict, archetype stability, Tier D
walk-forward null result). Reading a gitignored directory made those tests pass only on the machine that had run the R build, so the reports are tracked here.

Provenance: copied byte-for-byte from the developer build (2026-09-08 .. 2026-09-19; Tier A/C/D 2026-09-08, Tier B rebuilt 2026-09-19). They are BOUND to the committed served data:
`served_content_sha256` in the Tier A/B/C/D reconciliation reports equals the one the committed `data/player_scheme_manifest.json` records (Tier A: its version `psi:2025:w18:<sha12>`), asserted in
`test/player-scheme-certification.test.ts`. A report that no longer matches the served data fails that test.

Re-certification path (needs R + the nflverse cache; NOT part of `npm test`): `bash scripts/player-scheme-recertify.sh` rebuilds into a scratch directory and diffs against these files.
Never edit by hand; `SHA256SUMS` lists the tracked bytes.

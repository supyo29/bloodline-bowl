# Frozen capability vintage (FI week 2 PARTIAL / Role week 1)

The Analysis Book planner derives researchability from MOVING committed manifests (the football-intel refresh bot rewrites the FI manifest every few days; the intelligence-history bot grows
the preserved-state manifest). The planner tests assert the planner's *logic* for the vintage they were written against (first broken by bot commit `55b581f`, 2026-09-22), so they read this
frozen copy instead. These are byte copies from commit `43f64e4569a23e282667e8d4618b761918167d5b` (the last commit where the tests were green). The surface REGISTRY is intentionally NOT frozen: tests copy the live registry next to
these files (test/helpers/frozen-capability-root.ts) so registry-driven behavior keeps being exercised. Never edit by hand.

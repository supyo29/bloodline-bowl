/**
 * Phase 3.5C — explicit phase-number namespaces. The repository grew several independent numbering schemes; an
 * analyst that says "Phase 4" must say WHICH. Historic documents are not rewritten; this is metadata only.
 */
import type { PhaseNamespace, PhaseRef } from "./schema";

export const PHASE_NAMESPACES: Record<PhaseNamespace, { label: string; docs_glob: string; note: string }> = {
  INTELLIGENCE_MODERNIZATION_PHASE: { label: "Intelligence Modernization", docs_glob: "docs/INTELLIGENCE_MODERNIZATION_PHASE_*", note: "Phases 1-3, 3.5A-C, then 4+. 'Phase 4' here is the NEXT modernization phase." },
  TEAM_MANAGEMENT_PHASE: { label: "Team Management", docs_glob: "docs/TEAM_MANAGEMENT_PHASE_*", note: "Phases 1-9 (team-state, FI, Start/Sit FI = Phase 4, matchup = 5, roster health = 6, schedule = 7, orchestrator = 8, Player-Scheme = 9)." },
  TRADE_ENGINE_PHASE: { label: "Trade Engine", docs_glob: "docs/TRADE_ENGINE_PHASE*", note: "Phases 1-6 and 3.5." },
  FOOTBALL_INTELLIGENCE_PHASE: { label: "Football Intelligence (Phase 3 engine)", docs_glob: "docs/FOOTBALL_INTELLIGENCE_*", note: "The FI engine was built as 'Phase 3' of the Team Management scheme." },
  BRIDGE_REALTIME_STATE_STAGE: { label: "Bridge real-time state", docs_glob: "docs/BRIDGE_REALTIME_STATE_*", note: "Stages A-F." },
};

export const phaseRef = (namespace: PhaseNamespace, phase: string): PhaseRef => ({ namespace, phase });
/** Canonical printable form, e.g. `TEAM_MANAGEMENT_PHASE:4`. Never renders a bare number. */
export const formatPhaseRef = (r: PhaseRef): string => `${r.namespace}:${r.phase}`;

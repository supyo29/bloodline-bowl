/**
 * Bloodline Bowl MCP connector — contract constants.
 *
 * The MCP server is a TRANSPORT layer over the existing bridge routes. It never
 * computes fantasy points, projections, replacement value or recommendations
 * itself: every analytical number in a tool result comes from a bridge route
 * invoked in-process (lib/mcp/invoke.ts) and is reshaped, never recalculated.
 */

export const MCP_SERVER_NAME = "bloodline-bowl";
export const MCP_SERVER_TITLE = "Bloodline Bowl Fantasy Football Intelligence";
/** Bumped on any breaking change to a tool's input or envelope shape. */
export const MCP_CONTRACT_VERSION = "bloodline-mcp-2026.2";
export const MCP_SERVER_VERSION = "1.0.0";

/**
 * Access mode of this deployment. `PUBLIC_READ_ONLY` serves only data the
 * bridge already serves anonymously on its public `/api/*` routes; there is no
 * per-user identity and therefore no private data. See docs/MCP_CONNECTOR.md
 * ("Authentication & authorization") for the authenticated-mode design.
 */
export const MCP_ACCESS_MODE = "PUBLIC_READ_ONLY" as const;

/**
 * How a block of tool output may be used. Mirrors the bridge's own deployment
 * labels; the connector copies them, it never upgrades one.
 *   PRODUCTION      — the bridge's production recommendation / data path.
 *   SHARED_CONTEXT  — certified descriptive context (roster health, schedule planning).
 *   CURRENT_INTELLIGENCE — the current W2.R1 stack (Dynamic VOR, D/ST + K components, upside likelihood): live, read-only decision support whose COMPONENTS carry their own
 *                     scientific qualification (QUALIFIED_SHADOW, DIAGNOSTIC_ONLY, EXPLORATORY_POST_DEFECT, INSUFFICIENT_FINAL_SAMPLE, NO_RELIABLE_SIGNAL, UNAVAILABLE).
 *   ADVISORY_ONLY   — certified advisory synthesis (team-management orchestrator).
 *   SHADOW_ONLY     — research model output; never a production prediction.
 *   DESCRIPTIVE     — observed facts / historical records.
 */
export type Deployment = "PRODUCTION" | "CURRENT_INTELLIGENCE" | "SHARED_CONTEXT" | "ADVISORY_ONLY" | "SHADOW_ONLY" | "DESCRIPTIVE";

/**
 * Connector-level summary of whether the result can be acted on. Derived
 * conservatively from the bridge's own status fields — the connector may
 * downgrade (ACTIONABLE -> LIMITED) but never upgrades a bridge status.
 */
export type Actionability = "ACTIONABLE" | "LIMITED" | "NOT_ACTIONABLE" | "INFORMATIONAL";

export const SERVER_INSTRUCTIONS = [
  "Bloodline Bowl is a read-only fantasy football intelligence service for specific Sleeper and Yahoo leagues.",
  "Start with bloodline_list_leagues if the league is unknown, then bloodline_list_managers to find the user's manager. League and manager accept a slug, a Sleeper username, a display name or a team name; an ambiguous or unknown name returns candidates, never a guess.",
  "Always use the league's own scoring (bloodline_get_scoring) — never assume generic PPR.",
  "Weekly tools (weekly analysis, start/sit, matchup, waivers) serve ONLY the league's current week. For a past week use bloodline_week_history.",
  "Every result carries `status`, `actionability`, `limitations` and `deployment` labels. Report degraded, partial, unavailable and SHADOW_ONLY results as such; SHADOW_ONLY numbers are research output, not production predictions.",
  "There is no playoff-probability model: `playoff_odds` is null by design. Describe playoff position from standings and the strategic context, never invent a percentage.",
  "Dynamic VOR, D/ST/K components and upside likelihood (the current W2.R1 intelligence stack, deployment CURRENT_INTELLIGENCE) are live inputs to analysis: use them, but report each component's `qualification` state honestly — QUALIFIED_SHADOW is scientifically supported, DIAGNOSTIC_ONLY / EXPLORATORY_POST_DEFECT / INSUFFICIENT_FINAL_SAMPLE values inform analysis without being proven, NO_RELIABLE_SIGNAL means no adjustment exists, and UNKNOWN is never zero.",
  "Nothing here can submit lineups, claims, trades or messages.",
].join("\n");

/**
 * Phase 5 — DECLARED, NON-FITTED labelling cut-points. These decide only how a standardized interaction is DESCRIBED (advantage / neutral /
 * disadvantage); they carry no fantasy-point weight and were not tuned against outcomes. Changing one changes labels, never a projection.
 */
export const Z_MATERIAL = 0.75;             // |z| among the 32 defenses (for the same player) at which an interaction is labelled directional
export const MIN_DEFENSES_FOR_Z = 20;       // fewer comparable defenses => z is not computed
export const MIN_COVERED_SHARE = 0.5;       // share of the player's volume that must sit on cells with usable evidence on BOTH sides
export const MAJOR_CELL_SHARE = 0.08;       // cells above this share determine the player-side evidence tier
export const DEF_CHARTED_STRONG = 600; export const DEF_CHARTED_MODERATE = 300; export const DEF_CHARTED_WEAK = 100;
export const RZ_ROLE_MATERIAL_REC = 0.15; export const RZ_ROLE_MATERIAL_RUSH = 0.25;
export const MINOR_RECEIVING_ROLE = 0.05;

/**
 * Minimum |value| (in each family's own unit) for a directional label. Standardizing across defenses (z) says how extreme THIS defense is
 * for THIS player; it cannot say whether the player is sensitive to the dimension at all (a QB with a 0.01 EPA pressure split has the same z
 * ordering as one with a 0.8 split). Declared, not fitted: anything below is labelled NEUTRAL however extreme its z.
 */
export const MATERIAL_VALUE = { coverage: 0.005, pressure: 0.01, rusher: 0.01, area: 0.01, explosive: 0.01, run: 0.01, box: 0.005, unit: 0.03, red_zone: 0.02, line: 0.01 } as const;

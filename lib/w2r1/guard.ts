/**
 * W2.R1 is the current Bloodline intelligence stack and is served on every deployment, production included. Scientific qualification is per-component METADATA
 * (lib/w2r1/qualification.ts), not a deployment gate. `W2R1_DISABLED=1` is an operational emergency stop only (default: enabled).
 */
export function w2r1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.W2R1_DISABLED !== "1";
}

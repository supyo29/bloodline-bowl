/** W2.R1 early-shadow routes are never served from a Vercel PRODUCTION deployment (belt and braces on top of the branch not being merged). */
export function w2r1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.W2R1_SHADOW_DISABLED === "1") return false;
  return env.VERCEL_ENV !== "production" || env.W2R1_SHADOW_ENABLED === "1";
}

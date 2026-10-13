/**
 * LOCAL-ONLY GUARD for the staging harness. Importing this module aborts the process unless every Supabase target is the local Docker stack.
 * It exists because the repository's supabase/config.toml and README name the PRODUCTION project ref: nothing in this harness may ever reach it.
 */
const PROD_REF = "ijpfjdzmaztofawhwepf";

export function assertLocalOnly(env: NodeJS.ProcessEnv = process.env): { url: string } {
  const url = env.SUPABASE_URL ?? "";
  const bad: string[] = [];
  let host = "";
  try { host = new URL(url).hostname; } catch { bad.push("SUPABASE_URL is not a URL"); }
  if (host !== "127.0.0.1" && host !== "localhost") bad.push(`SUPABASE_URL host is "${host}", not loopback`);
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (v.includes(PROD_REF) || /\.supabase\.(co|com)\b/.test(v)) bad.push(`env ${k} references a hosted Supabase project`);
  }
  if (env.SUPABASE_PROJECT_REF) bad.push("SUPABASE_PROJECT_REF is set (it would redirect the REST client to a hosted project)");
  if (bad.length) {
    console.error(`REFUSING TO RUN — not a local-only environment:\n - ${bad.join("\n - ")}`);
    process.exit(99);
  }
  return { url };
}

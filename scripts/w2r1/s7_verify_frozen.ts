/**
 * Integrity check for scripts/w2r1/FROZEN.json. The S7 final scorer MUST call verifyFrozen() first and refuse to run on any problem.
 * Usage: npx tsx scripts/w2r1/s7_verify_frozen.ts   (exit 0 = intact)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { FROZEN_ARTIFACTS } from "./s7_freeze_artifacts";

export const PREREG_IMMUTABLE_SHA256 = "6caf1f70ad2a926b368927c521d799311f09191963bf17c957c6959701cb521d";
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

export function verifyFrozen(root = "."): string[] {
  const at = (p: string) => `${root}/${p}`; const problems: string[] = [];
  if (!existsSync(at("scripts/w2r1/FROZEN.json"))) return ["FROZEN.json missing"];
  const f = JSON.parse(readFileSync(at("scripts/w2r1/FROZEN.json"), "utf8")) as { artifacts_sha256: Record<string, string>; prereg_sha256: string; s7_adjudication_sha256: string; s4_spec_sha256: string; s5_spec_sha256: string; s6_spec_sha256: string; candidates: Array<{ id: string }> };
  if (!existsSync(at("scripts/w2r1/FROZEN.sha256")) || readFileSync(at("scripts/w2r1/FROZEN.sha256"), "utf8").trim() !== sha(at("scripts/w2r1/FROZEN.json"))) problems.push("FROZEN.json does not match FROZEN.sha256");
  const listed = Object.keys(f.artifacts_sha256).sort();
  if (JSON.stringify(listed) !== JSON.stringify([...FROZEN_ARTIFACTS].sort())) problems.push("artifact list differs from FROZEN_ARTIFACTS");
  for (const p of listed) { if (!existsSync(at(p))) { problems.push(`missing artifact ${p}`); continue; } if (sha(at(p)) !== f.artifacts_sha256[p]) problems.push(`hash mismatch ${p}`); }
  if (sha(at("scripts/w2r1/prereg.json")) !== PREREG_IMMUTABLE_SHA256 || f.prereg_sha256 !== PREREG_IMMUTABLE_SHA256) problems.push("prereg.json is not the immutable preregistration");
  for (const [k, p] of [["s4_spec_sha256", "s4_spec.json"], ["s5_spec_sha256", "s5_spec.json"], ["s6_spec_sha256", "s6_spec.json"], ["s7_adjudication_sha256", "s7_protocol_adjudication.json"]] as const) if (f[k] !== sha(at(`scripts/w2r1/${p}`))) problems.push(`${k} mismatch`);
  const ids = f.candidates.map((c) => c.id); if (new Set(ids).size !== ids.length) problems.push("duplicate candidate ids");
  return problems;
}
if (process.argv[1]?.endsWith("s7_verify_frozen.ts")) { const p = verifyFrozen(); if (p.length) { console.error("FROZEN INTEGRITY FAILURE:\n" + p.join("\n")); process.exit(1); } console.log("FROZEN.json intact"); }

/**
 * Phase 3.5D — interpret a user command against a session. Pure: returns what should happen (and the session with any
 * state consequence such as a queued refresh); it never retrieves evidence. Research is a separate, explicit step.
 */
import type { CapabilitySnapshot } from "./capability";
import { parseCommand, resolveSelector, nextChapters, type Resolution } from "./selection";
import { goDeeper, markNeedsRefresh, effectiveStatus, staleMap } from "./session";
import { contentsView, type ContentsView } from "./view";
import type { AnalysisBookSession } from "./schema";

export type Action =
  | { kind: "SHOW_CONTENTS"; view: ContentsView }
  | { kind: "OPEN"; research: string[]; recall: string[]; stale: string[]; depth: 1; notes: string[] }
  | { kind: "GO_DEEPER"; key: string; depth: number }
  | { kind: "REFRESH"; keys: string[]; skipped: string[]; notes: string[] }
  | { kind: "SYNTHESIZE"; final: boolean }
  | { kind: "ERROR"; message: string };

const RESEARCHED = ["EXPLORED", "PARTIAL", "STALE", "NEEDS_REFRESH"];

export function interpret(s: AnalysisBookSession, text: string, snap: CapabilitySnapshot): { action: Action; session: AnalysisBookSession } {
  const cmd = parseCommand(text); const fail = (message: string) => ({ action: { kind: "ERROR", message } as Action, session: s });
  const stale = staleMap(s, snap);
  const open = (r: Resolution) => {
    if (!r.ok) return fail(r.message);
    const research: string[] = []; const recall: string[] = []; const stl: string[] = [];
    for (const k of r.keys) { const st = effectiveStatus(s, k, stale); if (RESEARCHED.includes(s.chapters[k]!.status)) { recall.push(k); if (st === "STALE") stl.push(k); } else research.push(k); }
    return { action: { kind: "OPEN", research, recall, stale: stl, depth: 1, notes: r.notes } as Action, session: s };
  };
  switch (cmd.kind) {
    case "invalid": return fail(cmd.message);
    case "contents": return { action: { kind: "SHOW_CONTENTS", view: contentsView(s, snap) }, session: s };
    case "select": return open(resolveSelector(s, cmd.selector));
    case "next": return open(nextChapters(s, cmd.count));
    case "go_deeper": {
      let key: string | null = null;
      if (cmd.target) { const r = resolveSelector(s, cmd.target); if (!r.ok) return fail(r.message); if (r.keys.length !== 1) return fail("go deeper works on one chapter at a time"); key = r.keys[0]!; }
      const d = goDeeper(s, key); return d.ok ? { action: { kind: "GO_DEEPER", key: d.key, depth: d.nextDepth }, session: s } : fail(d.message);
    }
    case "refresh": {
      const r = resolveSelector(s, cmd.selector); if (!r.ok) return fail(r.message);
      const m = markNeedsRefresh(s, r.keys);
      if (!m.refreshed.length) return fail(`nothing to refresh: ${r.keys.map((k) => k.split("/")[0]).join(", ")} ${r.keys.length === 1 ? "has" : "have"} not been researched (open ${r.keys.length === 1 ? "it" : "them"} instead)`);
      const notes = [...r.notes]; if (m.skipped.length) notes.push(`not researched, skipped: ${m.skipped.join(", ")}`);
      return { action: { kind: "REFRESH", keys: m.refreshed, skipped: m.skipped, notes }, session: m.session };
    }
    case "synthesize": return { action: { kind: "SYNTHESIZE", final: cmd.final }, session: s };
  }
}

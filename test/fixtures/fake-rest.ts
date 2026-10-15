/**
 * In-memory stand-in for the subset of SupabaseRest the W1.P4 stores use: eq/lt/lte/gt/gte/is.null/in filters, order, limit/offset
 * (with a hard 1000-row page cap like PostgREST), insertIgnoreDuplicates, update/updateReturning. Deterministic; no network.
 */
import { SupabaseRestError, type SupabaseRest } from "../../lib/persistence/supabase/rest";

type Row = Record<string, unknown>;
const ISO = /^\d{4}-\d\d-\d\dT/;

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  if (ISO.test(sa) && ISO.test(sb)) return Date.parse(sa) - Date.parse(sb);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matches(row: Row, filter: Record<string, string>): boolean {
  for (const [col, expr] of Object.entries(filter)) {
    const v = row[col];
    const dot = expr.indexOf(".");
    const op = expr.slice(0, dot);
    const arg = expr.slice(dot + 1);
    if (op === "eq") {
      if (String(v) !== arg) return false;
    } else if (op === "is") {
      if (arg === "null" && v != null) return false;
    } else if (op === "in") {
      const list = arg.replace(/^\(|\)$/g, "").split(",");
      if (!list.includes(String(v))) return false;
    } else {
      if (v == null) return false; // PostgREST: comparisons against NULL are never true
      const c = cmp(v, ISO.test(arg) || Number.isNaN(Number(arg)) ? arg : Number(arg));
      if (op === "lt" && !(c < 0)) return false;
      if (op === "lte" && !(c <= 0)) return false;
      if (op === "gt" && !(c > 0)) return false;
      if (op === "gte" && !(c >= 0)) return false;
    }
  }
  return true;
}

export class FakeRest {
  tables = new Map<string, Row[]>();
  requests = 0;
  selects: Array<{ table: string; limit?: number; offset?: number }> = [];
  /** column names that do not exist (simulates a not-yet-applied migration) */
  missingColumns = new Set<string>();
  /** tables that do not exist */
  missingTables = new Set<string>();
  /** one-shot injected failures (consumed in order): any matching call throws the REAL wrapper error shape */
  failures: Array<{ method?: string; table: string; status: number; code?: string }> = [];

  t(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  /**
   * Errors are raised EXACTLY as `SupabaseRest` raises them in production: `Supabase <METHOD> <table> -> <status> [<code>]`, with structured
   * status/code/table/method and NO server text (the wrapper never echoes the response body). Codes follow PostgREST/Postgres:
   * reading or filtering a missing column -> 400 42703; writing a body key that is not a column -> 400 PGRST204; missing table -> 404 PGRST205.
   */
  #raise(method: string, table: string, status: number, code?: string): never {
    throw new SupabaseRestError(`Supabase ${method} ${table} -> ${status}${code ? ` [${code}]` : ""}`, status, table, code, method);
  }

  #guard(method: "GET" | "POST" | "PATCH", table: string, cols: string[]): void {
    const idx = this.failures.findIndex((f) => f.table === table && (!f.method || f.method === method));
    if (idx >= 0) {
      const f = this.failures.splice(idx, 1)[0]!;
      this.#raise(method, table, f.status, f.code);
    }
    if (this.missingTables.has(table)) this.#raise(method, table, 404, "PGRST205");
    for (const c of cols) if (this.missingColumns.has(c)) this.#raise(method, table, 400, method === "GET" ? "42703" : "PGRST204");
  }

  async select<T>(table: string, opts: { filter?: Record<string, string>; order?: string; limit?: number; offset?: number; select?: string } = {}): Promise<T[]> {
    this.requests += 1;
    this.selects.push({ table, limit: opts.limit, offset: opts.offset });
    this.#guard("GET", table, [...Object.keys(opts.filter ?? {}), ...(opts.select ? opts.select.split(",") : [])]);
    let rows = this.t(table).filter((r) => matches(r, opts.filter ?? {}));
    if (opts.order) {
      const keys = opts.order.split(",").map((o) => {
        const [col, dir] = o.split(".");
        return { col: col!, dir: dir === "desc" ? -1 : 1 };
      });
      rows = [...rows].sort((a, b) => {
        for (const k of keys) {
          const c = cmp(a[k.col], b[k.col]) * k.dir;
          if (c !== 0) return c;
        }
        return 0;
      });
    }
    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? 1000, 1000);
    return rows.slice(offset, offset + limit).map((r) => structuredClone(r)) as T[];
  }

  async insertIgnoreDuplicates<T>(table: string, rows: unknown[], conflictCols: string[]): Promise<T[]> {
    this.requests += 1;
    const out: Row[] = [];
    this.#guard("POST", table, []);
    for (const r of rows as Row[]) {
      this.#guard("POST", table, Object.keys(r));
      const dup = this.t(table).some((e) => conflictCols.every((c) => String(e[c]) === String(r[c])));
      if (!dup) {
        this.t(table).push(structuredClone(r));
        out.push(r);
      }
    }
    return out as T[];
  }

  async insert<T>(table: string, row: unknown): Promise<T[]> {
    this.requests += 1;
    this.#guard("POST", table, Object.keys(row as Row));
    this.t(table).push(structuredClone(row as Row));
    return [row as T];
  }

  async update(table: string, filter: Record<string, string>, patch: unknown): Promise<void> {
    await this.updateReturning(table, filter, patch);
  }

  async updateReturning<T>(table: string, filter: Record<string, string>, patch: unknown): Promise<T[]> {
    this.requests += 1;
    this.#guard("PATCH", table, [...Object.keys(filter), ...Object.keys(patch as Row)]);
    const out: Row[] = [];
    for (const r of this.t(table)) {
      if (matches(r, filter)) {
        Object.assign(r, structuredClone(patch as Row));
        out.push(structuredClone(r));
      }
    }
    return out as T[];
  }

  asRest(): SupabaseRest {
    return this as unknown as SupabaseRest;
  }
}

/**
 * Minimal Supabase PostgREST client — server-side only.
 *
 * Deliberately dependency-free (`fetch` + `URLSearchParams`), matching this
 * repo's zero-runtime-dependency posture. The service-role key is read from the
 * environment and NEVER logged, NEVER returned to a client, NEVER placed in a
 * response body.
 *
 *   SUPABASE_URL                 e.g. https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    service_role JWT — server secret
 *
 * `SUPABASE_PROJECT_REF` may be supplied instead of the full URL.
 */

import type { PersistenceStatus } from "../types";

export interface SupabaseRestConfig {
  url: string;
  serviceRoleKey: string;
}

export interface SupabaseConfigResult {
  configured: boolean;
  status: PersistenceStatus;
  config: SupabaseRestConfig | null;
  missing: string[];
}

export function loadSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfigResult {
  const explicitUrl = env.SUPABASE_URL?.trim();
  const ref = env.SUPABASE_PROJECT_REF?.trim();
  const url = explicitUrl || (ref ? `https://${ref}.supabase.co` : undefined);
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0 || !url || !key) {
    return { configured: false, status: "PERSISTENCE_NOT_CONFIGURED", config: null, missing };
  }
  return { configured: true, status: "READY", config: { url, serviceRoleKey: key }, missing: [] };
}

export class SupabaseRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly table: string,
    /** Postgres SQLSTATE from the PostgREST error body, when present (e.g. "23505"). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "SupabaseRestError";
  }
}

/** Postgres unique-violation SQLSTATE. */
export const PG_UNIQUE_VIOLATION = "23505";

type Filter = Record<string, string>;

export class SupabaseRest {
  #base: string;
  #headers: Record<string, string>;

  constructor(config: SupabaseRestConfig) {
    this.#base = `${config.url.replace(/\/$/, "")}/rest/v1`;
    this.#headers = {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
    };
  }

  async select<T>(
    table: string,
    opts: { filter?: Filter; order?: string; limit?: number; select?: string } = {},
  ): Promise<T[]> {
    const params = new URLSearchParams();
    params.set("select", opts.select ?? "*");
    for (const [k, v] of Object.entries(opts.filter ?? {})) params.set(k, v);
    if (opts.order) params.set("order", opts.order);
    if (opts.limit) params.set("limit", String(opts.limit));
    return this.#request<T[]>("GET", `${table}?${params.toString()}`, undefined, table);
  }

  /**
   * Conflict-safe bulk insert: `ON CONFLICT (<conflictColumns>) DO NOTHING`.
   *
   * `conflictColumns` is REQUIRED and MUST match a real unique index. Without an
   * explicit `on_conflict` target PostgREST infers the PRIMARY KEY, so a
   * violation of a *composite* UNIQUE constraint from a concurrent or repeated
   * insert would raise SQLSTATE 23505 instead of being ignored — which is the
   * exact concurrency defect this parameter fixes.
   *
   * With `return=representation` + `DO NOTHING`, PostgREST returns exactly the
   * rows that were actually inserted (skipped rows are not in `RETURNING`), so
   * `result.length` is a reliable "new" count and `seen - result.length` is a
   * reliable "already existed" count — safe under concurrency.
   */
  async insertIgnoreDuplicates<T>(
    table: string,
    rows: unknown[],
    conflictColumns: string[],
  ): Promise<T[]> {
    if (rows.length === 0) return [];
    if (conflictColumns.length === 0) {
      throw new Error("insertIgnoreDuplicates requires an explicit conflict target");
    }
    const path = `${table}?on_conflict=${conflictColumns.map(encodeURIComponent).join(",")}`;
    return this.#request<T[]>("POST", path, rows, table, {
      Prefer: "return=representation,resolution=ignore-duplicates",
    });
  }

  async insert<T>(table: string, row: unknown): Promise<T[]> {
    return this.#request<T[]>("POST", table, [row], table, { Prefer: "return=representation" });
  }

  async update(table: string, filter: Filter, patch: unknown): Promise<void> {
    const params = new URLSearchParams(filter);
    await this.#request("PATCH", `${table}?${params.toString()}`, patch, table, {
      Prefer: "return=minimal",
    });
  }

  async #request<T>(
    method: string,
    path: string,
    body: unknown,
    table: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(`${this.#base}/${path}`, {
        method,
        headers: { ...this.#headers, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // Never echo the response body wholesale (PostgREST `details` can contain
        // row values); surface only the SQLSTATE `code`, which is safe and useful.
        let code: string | undefined;
        try {
          const parsed = JSON.parse(text) as { code?: unknown };
          if (typeof parsed.code === "string") code = parsed.code;
        } catch {
          /* non-JSON error body */
        }
        throw new SupabaseRestError(
          `Supabase ${method} ${table} -> ${res.status}${code ? ` [${code}]` : ""}`,
          res.status,
          table,
          code,
        );
      }
      return (text ? JSON.parse(text) : []) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

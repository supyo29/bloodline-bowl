/**
 * MCP connector — protocol conformance through the real route handler
 * (app/api/mcp/route.ts), for both wire eras the server must serve:
 *   - 2025-era Streamable HTTP (initialize handshake, then tools/*), and
 *   - 2026-07-28 stateless requests (per-request `_meta` envelope, no handshake).
 * Offline-safe: only tools that need no provider data are invoked.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { POST } from "../app/api/mcp/route";
import { TOOLS } from "../lib/mcp/tools";
import { MCP_CONTRACT_VERSION } from "../lib/mcp/contract";

const MODERN = "2026-07-28";
const MODERN_META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} };

async function rpc(method: string, params: Record<string, unknown> = {}, opts: { modern?: boolean; id?: number | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (opts.modern) {
    headers["mcp-protocol-version"] = MODERN;
    headers["mcp-method"] = method;
    if (typeof params.name === "string") headers["mcp-name"] = params.name;
  }
  const body = { jsonrpc: "2.0", ...(opts.id === null ? {} : { id: opts.id ?? 1 }), method, params: opts.modern ? { ...params, _meta: MODERN_META } : params };
  const res = await POST(new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await res.text();
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)));
  const message = data.length ? data[data.length - 1] : text ? JSON.parse(text) : null;
  return { status: res.status, message };
}

describe("MCP protocol — 2025-era Streamable HTTP", () => {
  it("initialize negotiates a supported version and advertises tools + instructions", async () => {
    const { status, message } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(status, 200);
    assert.equal(message.result.protocolVersion, "2025-06-18");
    assert.equal(message.result.serverInfo.name, "bloodline-bowl");
    assert.ok(message.result.capabilities.tools);
    assert.match(message.result.instructions, /read-only/);
    assert.match(message.result.instructions, /SHADOW_ONLY/);
  });

  it("tools/list returns the full catalog, every tool read-only with an object input schema", async () => {
    const { message } = await rpc("tools/list");
    const tools = message.result.tools as Array<{ name: string; description: string; inputSchema: { type: string }; annotations: Record<string, unknown> }>;
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS.map((t) => t.name), "search", "fetch"].sort());
    assert.equal(tools.length, 19);
    for (const t of tools) {
      assert.match(t.name, /^(bloodline_[a-z_]+|search|fetch)$/);
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.ok(t.description.length > 40 && t.description.length < 600, `${t.name} description length`);
    }
  });

  it("tools/call returns the envelope as both structuredContent and JSON text", async () => {
    const { message } = await rpc("tools/call", { name: "bloodline_capabilities", arguments: {} });
    const r = message.result;
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.contract_version, MCP_CONTRACT_VERSION);
    assert.equal(r.structuredContent.access_mode, "PUBLIC_READ_ONLY");
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
    assert.equal(r.structuredContent.data.model_deployment.playoff_probability.deployment, "NOT_IMPLEMENTED");
  });

  it("invalid tool input is rejected by schema validation, not passed to the bridge", async () => {
    const { message } = await rpc("tools/call", { name: "bloodline_start_sit", arguments: { league: "bloodline-bowl", manager: "supyo29", week: 99 } });
    const failed = message.error !== undefined || message.result?.isError === true;
    assert.ok(failed, JSON.stringify(message).slice(0, 300));
  });

  it("fetch rejects an id search never issued", async () => {
    const { message } = await rpc("tools/call", { name: "fetch", arguments: { id: "bb:weekly:devoted-to-the-game" } });
    assert.equal(message.result.isError, true);
    assert.equal(message.result.structuredContent.metadata.status, "INVALID_INPUT");
  });

  it("an unknown tool is an error", async () => {
    const { message } = await rpc("tools/call", { name: "bloodline_submit_lineup", arguments: {} });
    assert.ok(message.error !== undefined || message.result?.isError === true);
  });

  it("an unsupported method is a JSON-RPC error", async () => {
    const { message } = await rpc("resources/write_everything", {});
    assert.ok(message.error, JSON.stringify(message));
  });

  it("unknown league / manager resolve to explicit errors with candidates, never a substitute", async () => {
    const { message } = await rpc("tools/call", { name: "bloodline_get_team", arguments: { league: "Imaginary League", manager: "supyo29" } });
    const env = message.result.structuredContent;
    assert.equal(message.result.isError, true);
    assert.equal(env.status, "LEAGUE_NOT_FOUND");
    assert.equal(env.actionability, "NOT_ACTIONABLE");
    assert.equal(env.data, null);
    assert.ok(env.error.candidates.some((c: { league_slug: string }) => c.league_slug === "devoted-to-the-game"));
  });
});

describe("MCP protocol — 2026-07-28 stateless requests", () => {
  it("server/discover works without an initialize handshake", async () => {
    const { status, message } = await rpc("server/discover", {}, { modern: true });
    assert.equal(status, 200);
    assert.ok(message.result.supportedVersions.includes(MODERN));
    assert.ok(message.result.capabilities.tools);
  });

  it("tools/list and tools/call work per-request with no session", async () => {
    const list = await rpc("tools/list", {}, { modern: true });
    assert.equal(list.message.result.tools.length, 19);
    const call = await rpc("tools/call", { name: "bloodline_capabilities", arguments: {} }, { modern: true });
    assert.equal(call.message.result.structuredContent.tool, "bloodline_capabilities");
  });

  it("concurrent requests are independent (no shared session state)", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => rpc("tools/list", {}, { modern: i % 2 === 0, id: i + 1 })));
    for (const [i, r] of results.entries()) {
      assert.equal(r.message.id, i + 1);
      assert.equal(r.message.result.tools.length, 19);
    }
  });
});

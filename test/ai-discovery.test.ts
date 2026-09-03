/**
 * AI-discovery layer — deterministic, no network.
 *
 * Proves a fresh AI assistant can bootstrap the whole bridge from /api/ai:
 * service description, leagues, known managers (mapped to the right league),
 * canonical routing, capability templates, no secrets — plus the crawler
 * discovery files (/robots.txt, /sitemap.xml, /llms.txt).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CAPABILITIES,
  discoveryLeagues,
  discoveryManagers,
  managerCapabilityUrls,
} from "../lib/discovery";

const SECRET_HINTS = [
  "SUPABASE",
  "SERVICE_ROLE",
  "YAHOO_CLIENT_SECRET",
  "CLIENT_SECRET",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "BEARER",
  "PASSWORD",
  "api_key",
  "apikey",
];

/** Walk a React element tree, collecting visible text and every `href` prop. */
function collectElement(node: unknown): { text: string; hrefs: string[] } {
  const hrefs: string[] = [];
  let text = "";
  const visit = (n: unknown): void => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      text += ` ${n}`;
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    const props = el.props ?? {};
    if (typeof props.href === "string") hrefs.push(props.href);
    if (typeof el.type === "function") {
      visit((el.type as (p: unknown) => unknown)(props));
      return;
    }
    visit(props.children);
  };
  visit(node);
  return { text, hrefs };
}

function assertNoSecrets(text: string): void {
  for (const hint of SECRET_HINTS) {
    assert.ok(
      !text.toLowerCase().includes(hint.toLowerCase()),
      `discovery output must not contain "${hint}"`,
    );
  }
}

describe("GET /api/ai", () => {
  it("returns 200 valid JSON with the production base URL and no secrets", async () => {
    const { GET } = await import("../app/api/ai/route");
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      body.service.production_base_url,
      "https://bloodline-bowl-sleeper-bridge.vercel.app",
    );
    assert.equal(body.service.read_only, true);
    assert.equal(body.meta.contains_secrets, false);
    assertNoSecrets(JSON.stringify(body));
  });

  it("advertises /api/leagues and both known leagues", async () => {
    const { GET } = await import("../app/api/ai/route");
    const body = await (await GET()).json();
    assert.equal(body.start_here.league_discovery, "/api/leagues");
    const slugs = body.leagues.map((l: { league_slug: string }) => l.league_slug);
    assert.ok(slugs.includes("bloodline-bowl"));
    assert.ok(slugs.includes("devoted-to-the-game"));
  });

  it("maps each known manager to the correct league with a canonical route", async () => {
    const { GET } = await import("../app/api/ai/route");
    const body = await (await GET()).json();
    const bySlug = new Map<string, { league_slug: string; canonical_url: string }>(
      body.registered_managers.map(
        (m: { manager_slug: string; league_slug: string; canonical_url: string }) => [
          m.manager_slug,
          m,
        ],
      ),
    );

    assert.deepEqual(
      {
        league: bySlug.get("bijimac")?.league_slug,
        url: bySlug.get("bijimac")?.canonical_url,
      },
      {
        league: "bloodline-bowl",
        url: "/api/leagues/bloodline-bowl/managers/bijimac",
      },
    );
    assert.deepEqual(
      {
        league: bySlug.get("darthmarker")?.league_slug,
        url: bySlug.get("darthmarker")?.canonical_url,
      },
      {
        league: "devoted-to-the-game",
        url: "/api/leagues/devoted-to-the-game/managers/darthmarker",
      },
    );
    assert.equal(bySlug.get("supyo29")?.league_slug, "bloodline-bowl");

    // No cross-league contamination.
    assert.equal(bySlug.get("darthmarker")?.league_slug !== "bloodline-bowl", true);
    assert.equal(bySlug.get("bijimac")?.league_slug !== "devoted-to-the-game", true);
  });

  it("exposes the weekly / waiver / lineup / matchup capability templates", async () => {
    const { GET } = await import("../app/api/ai/route");
    const body = await (await GET()).json();
    const templates: string[] = body.capabilities.map(
      (c: { route_template: string }) => c.route_template,
    );
    for (const expected of [
      "/api/intelligence/{leagueSlug}/{managerSlug}/week/{week}",
      "/api/waivers/{leagueSlug}/{managerSlug}/week/{week}",
      "/api/lineup/{leagueSlug}/{managerSlug}/week/{week}",
      "/api/matchup/{leagueSlug}/{managerSlug}/week/{week}",
      "/api/leagues/{leagueSlug}/managers/{managerSlug}/projections",
      "/api/leagues/{leagueSlug}/managers/{managerSlug}/recommendations",
      "/api/transactions/{leagueSlug}",
      "/api/history/{leagueSlug}/week/{week}",
    ]) {
      assert.ok(templates.includes(expected), `missing capability ${expected}`);
    }
  });

  it("documents that HTTP 200 is not 'actionable' and lists the status fields to check", async () => {
    const { GET } = await import("../app/api/ai/route");
    const body = await (await GET()).json();
    const instr = (body.service.ai_instructions as string[]).join(" ").toLowerCase();
    assert.ok(instr.includes("http 200"));
    assert.ok(instr.includes("blocked") && instr.includes("degraded"));
    assert.ok(instr.includes("auth_required"));

    const sem = body.endpoint_status_semantics;
    assert.ok(sem.you_must_also_check.includes("status"));
    assert.ok(sem.you_must_also_check.includes("warnings"));
    assert.ok(
      sem.non_actionable_states_that_still_return_200.includes(
        "PERSISTENCE_NOT_CONFIGURED",
      ),
    );
  });

  it("scopes the word 'canonical' to the discovery contract, not a uniform prefix", async () => {
    const { GET } = await import("../app/api/ai/route");
    const body = await (await GET()).json();
    assert.equal(body.discovery_contract.canonical_entry_point, "/api/ai");
    const note = String(body.discovery_contract.note).toLowerCase();
    assert.ok(note.includes("/api/league/"));
    assert.ok(note.includes("do not infer route structure"));
    // The advertised capability templates genuinely span multiple namespaces.
    const prefixes = new Set(
      body.capabilities.map(
        (c: { route_template: string }) => c.route_template.split("/")[2],
      ),
    );
    assert.ok(prefixes.size > 1, "capabilities should span >1 namespace");
    assert.ok(prefixes.has("intelligence"));
    assert.ok(prefixes.has("context"));
  });

  it("labels legacy ?league= routes as legacy, canonical routes as canonical", async () => {
    const { GET } = await import("../app/api/ai/route");
    const body = await (await GET()).json();
    assert.ok(Array.isArray(body.legacy_routes.routes));
    assert.ok(
      body.legacy_routes.routes.some((r: { route_template: string }) =>
        r.route_template.includes("?league="),
      ),
    );
    assert.ok(body.capabilities.every((c: { canonical: boolean }) => c.canonical));
    assert.equal(body.service.github_repository.includes("github.com"), true);
  });
});

describe("manager capability URL map", () => {
  it("gives a manager every post-draft tool without a second lookup", () => {
    const urls = managerCapabilityUrls("bloodline-bowl", "bijimac");
    assert.equal(
      urls.weekly_intelligence,
      "/api/intelligence/bloodline-bowl/bijimac/week/{week}",
    );
    assert.equal(
      urls.weekly_waivers,
      "/api/waivers/bloodline-bowl/bijimac/week/{week}",
    );
    assert.equal(
      urls.weekly_lineup,
      "/api/lineup/bloodline-bowl/bijimac/week/{week}",
    );
    assert.equal(
      urls.weekly_matchup,
      "/api/matchup/bloodline-bowl/bijimac/week/{week}",
    );
    assert.equal(
      urls.manager_projections,
      "/api/leagues/bloodline-bowl/managers/bijimac/projections",
    );
    assert.equal(
      urls.manager_recommendations,
      "/api/leagues/bloodline-bowl/managers/bijimac/recommendations",
    );
    assert.equal(urls.transactions, "/api/transactions/bloodline-bowl");
    assert.equal(urls.scoring, "/api/leagues/bloodline-bowl/scoring");
  });

  it("darthmarker resolves only inside devoted-to-the-game", () => {
    const mgrs = discoveryManagers();
    const darth = mgrs.filter((m) => m.manager_slug === "darthmarker");
    assert.equal(darth.length, 1);
    assert.equal(darth[0]?.league_slug, "devoted-to-the-game");
  });
});

describe("discovery capability catalog", () => {
  it("excludes debug / operational routes", () => {
    for (const c of CAPABILITIES) {
      for (const bad of ["/api/cron", "/api/raw", "/api/auth", "/api/draft/debug", "/bridge"]) {
        assert.ok(
          !c.route_template.startsWith(bad),
          `${c.route_template} should not be advertised`,
        );
      }
    }
  });

  it("every league has the eight canonical URL kinds", () => {
    for (const l of discoveryLeagues()) {
      for (const key of [
        "overview",
        "managers",
        "state",
        "scoring",
        "projections",
        "draft",
        "snapshot",
        "transactions",
      ] as const) {
        assert.ok(l.canonical_urls[key], `${l.league_slug} missing ${key}`);
      }
    }
  });
});

describe("/ai human-readable landing page", () => {
  it("is index/follow and points at /api/ai with fantasy-analysis language", async () => {
    const mod = await import("../app/ai/page");
    const meta = mod.metadata;
    assert.deepEqual(meta.robots, { index: true, follow: true });
    assert.equal(meta.alternates?.canonical, "/ai");
    const blob = `${meta.title} ${meta.description}`.toLowerCase();
    for (const term of [
      "fantasy football",
      "intelligence",
      "projections",
      "waiver",
      "lineup",
      "matchup",
    ]) {
      assert.ok(blob.includes(term), `metadata should mention "${term}"`);
    }
  });

  it("renders manager names and the three direct manager links as real HTML", async () => {
    const mod = await import("../app/ai/page");
    const { text, hrefs } = collectElement(mod.default());
    for (const name of ["Supyo29", "BijiMac", "DarthMarker", "Bloodline Bowl", "Devoted to the Game"]) {
      assert.ok(text.includes(name), `/ai should contain the text "${name}"`);
    }
    for (const href of [
      "/api/ai",
      "/api/leagues/bloodline-bowl/managers/supyo29",
      "/api/leagues/bloodline-bowl/managers/bijimac",
      "/api/leagues/devoted-to-the-game/managers/darthmarker",
    ]) {
      assert.ok(hrefs.includes(href), `/ai should link to ${href}`);
    }
    for (const heading of [
      "Roster and current-state analysis",
      "Weekly intelligence",
      "Waiver / add-drop analysis",
      "Lineup and start/sit optimization",
      "Matchup analysis",
      "Transactions and history",
    ]) {
      assert.ok(text.includes(heading), `/ai should have a "${heading}" heading`);
    }
  });
});

describe("crawler discovery files", () => {
  it("/robots.txt allows crawling and points at the sitemap", async () => {
    const mod = await import("../app/robots");
    const robots = mod.default();
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    assert.equal(rules[0]?.allow, "/");
    assert.equal(
      robots.sitemap,
      "https://bloodline-bowl-sleeper-bridge.vercel.app/sitemap.xml",
    );
  });

  it("/sitemap.xml lists the durable discovery roots", async () => {
    const mod = await import("../app/sitemap");
    const entries = mod.default();
    const urls = entries.map((e) => e.url);
    assert.ok(
      urls.includes("https://bloodline-bowl-sleeper-bridge.vercel.app/api/ai"),
    );
    assert.ok(
      urls.includes("https://bloodline-bowl-sleeper-bridge.vercel.app/"),
    );
    assert.ok(
      urls.includes("https://bloodline-bowl-sleeper-bridge.vercel.app/ai"),
    );
    assert.ok(
      urls.includes(
        "https://bloodline-bowl-sleeper-bridge.vercel.app/api/leagues/bloodline-bowl/managers/bijimac",
      ),
    );
    assert.ok(
      urls.includes(
        "https://bloodline-bowl-sleeper-bridge.vercel.app/api/leagues/devoted-to-the-game/managers/darthmarker",
      ),
    );
  });

  it("/llms.txt returns text/plain with the entry point, identity rule, and no secrets", async () => {
    const { GET } = await import("../app/llms.txt/route");
    const res = await GET();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    const text = await res.text();
    assert.ok(text.includes("/api/ai"));
    assert.ok(text.toLowerCase().includes("league identity != manager identity"));
    assert.ok(text.includes("/api/leagues/devoted-to-the-game/managers/darthmarker"));
    assert.ok(text.includes("/api/leagues/bloodline-bowl/managers/bijimac"));
    assertNoSecrets(text);
  });
});

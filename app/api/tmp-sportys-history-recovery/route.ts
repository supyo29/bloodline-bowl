export const dynamic = "force-static";
export const runtime = "nodejs";
export const revalidate = false;

const CURRENT_2025 = "1255589856759775232";
const DEAD_2024 = "1125318062596050944";
const GUESSED_DRAFT_2024 = "1125318062596050945";

const PROBES = [
  { key: "league_2025", url: `https://api.sleeper.app/v1/league/${CURRENT_2025}` },
  { key: "league_2024", url: `https://api.sleeper.app/v1/league/${DEAD_2024}` },
  { key: "users_2024", url: `https://api.sleeper.app/v1/league/${DEAD_2024}/users` },
  { key: "rosters_2024", url: `https://api.sleeper.app/v1/league/${DEAD_2024}/rosters` },
  { key: "drafts_2024", url: `https://api.sleeper.app/v1/league/${DEAD_2024}/drafts` },
  { key: "draft_2024_guess", url: `https://api.sleeper.app/v1/draft/${GUESSED_DRAFT_2024}` },
  { key: "draft_picks_2024_guess", url: `https://api.sleeper.app/v1/draft/${GUESSED_DRAFT_2024}/picks` },
  { key: "matchups_w1_2024", url: `https://api.sleeper.app/v1/league/${DEAD_2024}/matchups/1` },
  { key: "transactions_w1_2024", url: `https://api.sleeper.app/v1/league/${DEAD_2024}/transactions/1` },
] as const;

export async function GET(): Promise<Response> {
  const results = await Promise.all(
    PROBES.map(async ({ key, url }) => {
      try {
        const response = await fetch(url, { cache: "force-cache" });
        const text = await response.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {}
        const row = { key, status: response.status, ok: response.ok, body };
        console.log("SPORTYS_DELETED_PROBE", JSON.stringify(row));
        return row;
      } catch (error) {
        const row = { key, status: 0, ok: false, error: error instanceof Error ? error.message : "Unknown error" };
        console.log("SPORTYS_DELETED_PROBE", JSON.stringify(row));
        return row;
      }
    }),
  );

  return Response.json({ current_2025: CURRENT_2025, dead_2024: DEAD_2024, guessed_draft_2024: GUESSED_DRAFT_2024, results });
}

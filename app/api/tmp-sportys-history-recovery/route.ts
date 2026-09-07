export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const USERS = [
  { user_id: "469961070534979584", display_name: "rspata2" },
  { user_id: "861284798281412608", display_name: "dusty22k" },
  { user_id: "1134000198134525952", display_name: "cslan33" },
  { user_id: "1136141810541178880", display_name: "battmurwinkle" },
] as const;

const SEASONS = ["2024", "2023", "2022", "2021", "2020"] as const;

export async function GET(): Promise<Response> {
  const rows = await Promise.all(
    USERS.flatMap((user) =>
      SEASONS.map(async (season) => {
        const url = `https://api.sleeper.app/v1/user/${user.user_id}/leagues/nfl/${season}`;
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) {
            return {
              user_id: user.user_id,
              display_name: user.display_name,
              season,
              ok: false,
              status: response.status,
              leagues: [],
            };
          }
          const leagues = (await response.json()) as Array<Record<string, unknown>>;
          return {
            user_id: user.user_id,
            display_name: user.display_name,
            season,
            ok: true,
            status: response.status,
            leagues: leagues.map((league) => ({
              league_id: league.league_id,
              name: league.name,
              season: league.season,
              total_rosters: league.total_rosters,
              status: league.status,
              previous_league_id: league.previous_league_id,
              draft_id: league.draft_id,
              avatar: league.avatar,
            })),
          };
        } catch (error) {
          return {
            user_id: user.user_id,
            display_name: user.display_name,
            season,
            ok: false,
            status: 0,
            error: error instanceof Error ? error.message : "Unknown error",
            leagues: [],
          };
        }
      }),
    ),
  );

  return Response.json({ users: USERS, seasons: SEASONS, rows }, {
    headers: { "Cache-Control": "no-store" },
  });
}

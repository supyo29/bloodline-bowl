export const dynamic = "force-static";
export const runtime = "nodejs";
export const revalidate = false;

const USERS = [
  { user_id: "861284798281412608", display_name: "dusty22k" },
  { user_id: "1255595134498643968", display_name: "Stausa" },
  { user_id: "1255595575798140928", display_name: "TylerShreve" },
  { user_id: "1136141810541178880", display_name: "battmurwinkle" },
  { user_id: "1255630198565523456", display_name: "schroyjd" },
  { user_id: "1134000198134525952", display_name: "cslan33" },
  { user_id: "1255951887002243072", display_name: "dbaker4141" },
  { user_id: "1255996308120928256", display_name: "Randyqn" },
  { user_id: "1255997913989906432", display_name: "KtMize" },
  { user_id: "1256001946100183040", display_name: "WiehoffNw" },
  { user_id: "1264708964440879104", display_name: "dallyboy99" },
  { user_id: "1265020147614093312", display_name: "nickk376" },
  { user_id: "469961070534979584", display_name: "rspata2" },
  { user_id: "1265477633718624256", display_name: "mallermb" },
] as const;

type LeagueSummary = {
  league_id?: unknown;
  name?: unknown;
  season?: unknown;
  total_rosters?: unknown;
  status?: unknown;
  previous_league_id?: unknown;
  draft_id?: unknown;
};

type Row = {
  user_id: string;
  display_name: string;
  season: string;
  ok: boolean;
  status: number;
  leagues: Array<{
    league_id: unknown;
    name: unknown;
    season: unknown;
    total_rosters: unknown;
    status: unknown;
    previous_league_id: unknown;
    draft_id: unknown;
  }>;
  error?: string;
};

export async function GET(): Promise<Response> {
  const season = "2024";
  const rows: Row[] = await Promise.all(
    USERS.map(async (user) => {
      const url = `https://api.sleeper.app/v1/user/${user.user_id}/leagues/nfl/${season}`;
      try {
        const response = await fetch(url, { cache: "force-cache" });
        if (!response.ok) {
          const row: Row = { user_id: user.user_id, display_name: user.display_name, season, ok: false, status: response.status, leagues: [] };
          console.log("SPORTYS_2024_USER", JSON.stringify(row));
          return row;
        }
        const leagues = (await response.json()) as LeagueSummary[];
        const row: Row = {
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
          })),
        };
        console.log("SPORTYS_2024_USER", JSON.stringify(row));
        return row;
      } catch (error) {
        const row: Row = {
          user_id: user.user_id,
          display_name: user.display_name,
          season,
          ok: false,
          status: 0,
          error: error instanceof Error ? error.message : "Unknown error",
          leagues: [],
        };
        console.log("SPORTYS_2024_USER", JSON.stringify(row));
        return row;
      }
    }),
  );

  const overlap = new Map<string, { league_id: string; name: unknown; total_rosters: unknown; previous_league_id: unknown; managers: string[] }>();
  for (const row of rows) {
    for (const league of row.leagues) {
      if (typeof league.league_id !== "string") continue;
      const existing = overlap.get(league.league_id) ?? {
        league_id: league.league_id,
        name: league.name,
        total_rosters: league.total_rosters,
        previous_league_id: league.previous_league_id,
        managers: [],
      };
      existing.managers.push(row.display_name);
      overlap.set(league.league_id, existing);
    }
  }

  const candidates = [...overlap.values()].sort((a, b) => b.managers.length - a.managers.length);
  for (const candidate of candidates) {
    console.log("SPORTYS_2024_CANDIDATE", JSON.stringify(candidate));
  }

  return Response.json({ season, rows, candidates });
}

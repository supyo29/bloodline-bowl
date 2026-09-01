/**
 * Historical NFL season actuals, from Sleeper's own box-score feed
 * (`/v1/stats/nfl/regular/{season}`). This is box-score data, NOT anyone's
 * projection — it is the training signal for the Roster Intel model and the
 * ground truth for backtests.
 *
 * The feed carries snap counts (`off_snp` / `tm_off_snp`), targets
 * (`rec_tgt`), red-zone usage (`rec_rz_tgt`, `rush_rz_att`, `g2g_att`), air
 * yards, and games played — enough to build an opportunity-first model without
 * an external play-by-play source.
 */

import { getSeasonStats } from "@/lib/sleeper/client";
import type { FantasyPosition } from "./schema";

export interface PlayerSeasonActual {
  player_id: string;
  season: number;
  position: FantasyPosition | null;
  team: string | null;
  gp: number;
  gs: number;
  off_snp: number;
  tm_off_snp: number;
  snap_share: number | null;

  pass_att: number;
  pass_cmp: number;
  pass_yd: number;
  pass_td: number;
  pass_int: number;
  pass_rz_att: number;

  rush_att: number;
  rush_yd: number;
  rush_td: number;
  rush_rz_att: number;
  g2g_att: number;

  targets: number;
  rec: number;
  rec_yd: number;
  rec_td: number;
  rec_air_yd: number;
  rec_rz_tgt: number;

  fum_lost: number;

  /** Kicking */
  fgm: number;
  fga: number;
  fgm_yds: number;
  xpm: number;
  xpa: number;

  /** Defense */
  def_sack: number;
  def_int: number;
  def_fum_rec: number;
  def_td: number;
  def_safety: number;

  pts_ppr: number;
}

export interface TeamSeasonTotals {
  pass_att: number;
  rush_att: number;
  targets: number;
  pass_td: number;
  rush_td: number;
  rec_td: number;
  plays: number;
  /** True when read from Sleeper's authoritative `TEAM_XXX` row. */
  authoritative: boolean;
}

export interface SeasonActuals {
  season: number;
  players: Map<string, PlayerSeasonActual>;
  team_totals: Map<string, TeamSeasonTotals>;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const POS = new Set<FantasyPosition>(["QB", "RB", "WR", "TE", "K", "DEF"]);

/**
 * Load one completed season's actuals. `positionByPlayer` maps player_id ->
 * current position (from the live player index) so we can position-tag rows
 * whose own record lacks a clean position.
 */
export async function loadSeasonActuals(
  season: number,
  positionByPlayer: Map<string, { position: string | null; team: string | null }>,
): Promise<SeasonActuals> {
  const raw = await getSeasonStats(String(season));
  const players = new Map<string, PlayerSeasonActual>();
  const teamTotals = new Map<string, TeamSeasonTotals>();

  // Sleeper's authoritative per-team season totals ("TEAM_BUF" -> { pass_att, ... }).
  for (const [key, st] of Object.entries(raw ?? {})) {
    if (!key.startsWith("TEAM_") || !st || typeof st !== "object") continue;
    const team = key.slice("TEAM_".length);
    teamTotals.set(team, {
      pass_att: n(st.pass_att),
      rush_att: n(st.rush_att),
      targets: n(st.rec_tgt) || n(st.pass_att) * 0.94,
      pass_td: n(st.pass_td),
      rush_td: n(st.rush_td),
      rec_td: n(st.rec_td) || n(st.pass_td),
      plays: n(st.pass_att) + n(st.rush_att),
      authoritative: true,
    });
  }

  for (const [pid, st] of Object.entries(raw ?? {})) {
    if (pid.startsWith("TEAM_")) continue;
    if (!st || typeof st !== "object") continue;
    const meta = positionByPlayer.get(pid);
    const posRaw = (meta?.position ?? "").toUpperCase();
    const position = POS.has(posRaw as FantasyPosition)
      ? (posRaw as FantasyPosition)
      : null;
    const team = meta?.team ?? null;

    const offSnp = n(st.off_snp);
    const tmOffSnp = n(st.tm_off_snp);
    const row: PlayerSeasonActual = {
      player_id: pid,
      season,
      position,
      team,
      gp: n(st.gp),
      gs: n(st.gs),
      off_snp: offSnp,
      tm_off_snp: tmOffSnp,
      snap_share: tmOffSnp > 0 ? offSnp / tmOffSnp : null,
      pass_att: n(st.pass_att),
      pass_cmp: n(st.pass_cmp),
      pass_yd: n(st.pass_yd),
      pass_td: n(st.pass_td),
      pass_int: n(st.pass_int),
      pass_rz_att: n(st.pass_rz_att),
      rush_att: n(st.rush_att),
      rush_yd: n(st.rush_yd),
      rush_td: n(st.rush_td),
      rush_rz_att: n(st.rush_rz_att),
      g2g_att: n(st.g2g_att),
      targets: n(st.rec_tgt),
      rec: n(st.rec),
      rec_yd: n(st.rec_yd),
      rec_td: n(st.rec_td),
      rec_air_yd: n(st.rec_air_yd),
      rec_rz_tgt: n(st.rec_rz_tgt),
      fum_lost: n(st.fum_lost),
      fgm: n(st.fgm),
      fga: n(st.fga),
      fgm_yds: n(st.fgm_yds),
      xpm: n(st.xpm),
      xpa: n(st.xpa),
      def_sack: n(st.sack),
      def_int: n(st.int),
      def_fum_rec: n(st.fum_rec),
      def_td: n(st.fum_rec_td) + n(st.int_ret_td) + n(st.def_td),
      def_safety: n(st.safe),
      pts_ppr: n(st.pts_ppr),
    };
    players.set(pid, row);

    // Fallback team total (player-sum) only for teams with no authoritative row.
    if (team && !teamTotals.get(team)?.authoritative) {
      const t = teamTotals.get(team) ?? {
        pass_att: 0, rush_att: 0, targets: 0,
        pass_td: 0, rush_td: 0, rec_td: 0, plays: 0, authoritative: false,
      };
      t.pass_att += row.pass_att;
      t.rush_att += row.rush_att;
      t.targets += row.targets;
      t.pass_td += row.pass_td;
      t.rush_td += row.rush_td;
      t.rec_td += row.rec_td;
      t.plays = t.pass_att + t.rush_att;
      teamTotals.set(team, t);
    }
  }

  return { season, players, team_totals: teamTotals };
}

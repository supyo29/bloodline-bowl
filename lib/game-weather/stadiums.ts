/**
 * Home-stadium registry (location + roof type). Coordinates match the ones the legacy weather rows carried (their NWS points URLs) where present;
 * the rest are the published stadium coordinates. Roof TYPE is fixed per stadium; roof STATUS for retractable roofs (open/closed) is decided on game day
 * and is NOT available from any pre-kickoff source used here — it stays null, never guessed.
 * Neutral-site games (e.g. international) are NOT at the home club's stadium: the capture skips them (ESPN `neutralSite`).
 */
export type RoofType = "dome" | "retractable" | "outdoor";
export interface Stadium { team: string; name: string; lat: number; lon: number; roof: RoofType }
export const STADIUMS: Readonly<Record<string, Stadium>> = Object.fromEntries(([
  ["ARI", "State Farm Stadium", 33.5276, -112.2626, "retractable"], ["ATL", "Mercedes-Benz Stadium", 33.7554, -84.4009, "retractable"], ["BAL", "M&T Bank Stadium", 39.2781, -76.6227, "outdoor"],
  ["BUF", "Highmark Stadium", 42.7738, -78.7868, "outdoor"], ["CAR", "Bank of America Stadium", 35.2258, -80.8528, "outdoor"], ["CHI", "Soldier Field", 41.8623, -87.6167, "outdoor"],
  ["CIN", "Paycor Stadium", 39.0954, -84.516, "outdoor"], ["CLE", "Huntington Bank Field", 41.5061, -81.6995, "outdoor"], ["DAL", "AT&T Stadium", 32.7473, -97.0945, "retractable"],
  ["DEN", "Empower Field at Mile High", 39.7439, -105.0201, "outdoor"], ["DET", "Ford Field", 42.34, -83.0456, "dome"], ["GB", "Lambeau Field", 44.5013, -88.0622, "outdoor"],
  ["HOU", "NRG Stadium", 29.6847, -95.4107, "retractable"], ["IND", "Lucas Oil Stadium", 39.7601, -86.1639, "retractable"], ["JAX", "EverBank Stadium", 30.3239, -81.6373, "outdoor"],
  ["KC", "GEHA Field at Arrowhead Stadium", 39.0489, -94.4839, "outdoor"], ["LAC", "SoFi Stadium", 33.9535, -118.3392, "outdoor"], ["LAR", "SoFi Stadium", 33.9535, -118.3392, "outdoor"],
  ["LV", "Allegiant Stadium", 36.0909, -115.1833, "dome"], ["MIA", "Hard Rock Stadium", 25.958, -80.2389, "outdoor"], ["MIN", "U.S. Bank Stadium", 44.9735, -93.2575, "dome"],
  ["NE", "Gillette Stadium", 42.0909, -71.2643, "outdoor"], ["NO", "Caesars Superdome", 29.9511, -90.0812, "dome"], ["NYG", "MetLife Stadium", 40.8135, -74.0745, "outdoor"],
  ["NYJ", "MetLife Stadium", 40.8135, -74.0745, "outdoor"], ["PHI", "Lincoln Financial Field", 39.9008, -75.1675, "outdoor"], ["PIT", "Acrisure Stadium", 40.4468, -80.0158, "outdoor"],
  ["SEA", "Lumen Field", 47.5952, -122.3316, "outdoor"], ["SF", "Levi's Stadium", 37.403, -121.97, "outdoor"], ["TB", "Raymond James Stadium", 27.9759, -82.5033, "outdoor"],
  ["TEN", "Nissan Stadium", 36.1665, -86.7713, "outdoor"], ["WAS", "Northwest Stadium", 38.9076, -76.8645, "outdoor"],
] as const).map(([team, name, lat, lon, roof]) => [team, { team, name, lat, lon, roof }])) as Record<string, Stadium>;

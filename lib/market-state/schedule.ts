import { SLEEPER_ROOT_URL, fetchSleeper } from "@/lib/sleeper/client";
import type { ScheduleGameInput } from "./build";
/** NFL schedule is provider-neutral football fact; one reader serves every provider's market state. */
export const fetchNflSchedule = async (season: number): Promise<ScheduleGameInput[]> => { const g = await fetchSleeper<ScheduleGameInput[]>(`/schedule/nfl/regular/${season}`, { baseUrl: SLEEPER_ROOT_URL, noStore: true, timeoutMs: 2000 }); if (!Array.isArray(g)) throw new Error("schedule shape"); return g; };

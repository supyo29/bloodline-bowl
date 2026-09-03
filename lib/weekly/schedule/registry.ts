import { SleeperScheduleProvider } from "./sleeper-schedule";
import type { ScheduleProvider } from "./types";

/** The NFL schedule is provider-independent (it is the same for every league). */
export function getScheduleProvider(): ScheduleProvider {
  return new SleeperScheduleProvider();
}

export type { ScheduleProvider, WeekSchedule } from "./types";

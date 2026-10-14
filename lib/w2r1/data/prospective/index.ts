/** Registry of FROZEN pregame captures bundled with the app (explicit literal dynamic imports so the bundler traces them). Append one line per frozen week; never edit a frozen week's files. */
import type { KdstCapture } from "../../dst-live";
import type { UpsideCapture } from "../../upside-live";
export const KDST_LOADERS: Record<number, () => Promise<KdstCapture>> = {
  6: () => import("./wk06/kdst_components.json").then((m) => m.default as unknown as KdstCapture),
};
export const UPSIDE_LOADERS: Record<number, () => Promise<UpsideCapture>> = {
  6: () => import("./wk06/upside.json").then((m) => m.default as unknown as UpsideCapture),
};
export const CAPTURED_WEEKS: readonly number[] = Object.keys(KDST_LOADERS).map(Number).sort((a, b) => a - b);

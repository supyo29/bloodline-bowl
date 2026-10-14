/**
 * Infra guard (Vercel function storage): lib/trades/competitive/calibration.ts carries a `turbopackIgnore` on its dynamic
 * readFileSync so the build stops tracing the whole project. This proves the runtime behaviour is unchanged: the default
 * (statically scoped) path still loads the committed calibration artifact instead of silently falling back to DEFAULT_PRIOR.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPETITIVE_MARKET_CALIBRATION_VERSION,
  DEFAULT_COMPETITIVE_MARKET_CALIBRATION,
  loadCompetitiveMarketCalibration,
} from "../lib/trades/competitive/calibration";

const ARTIFACT = join(process.cwd(), "lib", "trades", "data", "competitive_market_calibration.json");

test("calibration artifact exists at the statically traced path", () => {
  assert.ok(existsSync(ARTIFACT));
});

test("default-path load returns the artifact, not DEFAULT_PRIOR", () => {
  const cal = loadCompetitiveMarketCalibration();
  const raw = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  assert.equal(cal.version, COMPETITIVE_MARKET_CALIBRATION_VERSION);
  assert.notEqual(cal, DEFAULT_COMPETITIVE_MARKET_CALIBRATION);
  assert.notEqual(cal.status, "DEFAULT_PRIOR");
  assert.deepEqual(Object.keys(cal.by_position_metric).sort(), Object.keys(raw.by_position_metric).sort());
  assert.ok(Object.keys(cal.by_position_metric).length > 0);
});

test("fileOverride path still loads the same artifact", () => {
  const a = loadCompetitiveMarketCalibration(ARTIFACT);
  const b = loadCompetitiveMarketCalibration();
  assert.deepEqual(a.by_position_metric, b.by_position_metric);
  assert.equal(a.status, b.status);
});

test("missing override falls back to the documented default", () => {
  assert.equal(loadCompetitiveMarketCalibration("/nonexistent/cal.json"), DEFAULT_COMPETITIVE_MARKET_CALIBRATION);
});

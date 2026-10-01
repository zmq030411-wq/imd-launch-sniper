import assert from "node:assert/strict";
import test from "node:test";
import { assertFreshLaunch, launchDeadline, LaunchFreshnessError } from "../src/launch-freshness.js";
import { configSchema } from "../src/config.js";

const launch = { number: 101n, timestamp: 1000n };
test("launch age is bounded by chain time and wall time, including exact expiry", () => {
  assert.doesNotThrow(() => assertFreshLaunch(launch, { number: 110n, timestamp: 1108n }, 120, 1119000));
  assert.throws(() => assertFreshLaunch(launch, { number: 701n, timestamp: 8200n }, 120, 8200000), /时效上限/);
  assert.throws(() => assertFreshLaunch(launch, launch, 120, 1120000), /时效上限/);
  assert.throws(() => assertFreshLaunch(launch, { number: 111n, timestamp: 1120n }, 120, 1110000), /时效上限/);
});
test("future timestamps, clock regressions and invalid block ordering fail closed", () => {
  assert.throws(() => assertFreshLaunch(launch, launch, 120, 900000), /时钟不一致/);
  assert.throws(() => assertFreshLaunch(launch, { number: 100n, timestamp: 1000n }, 120, 1000000), /不一致/);
  assert.throws(() => assertFreshLaunch(launch, { number: 102n, timestamp: 999n }, 120, 1000000), /不一致/);
  assert.throws(() => assertFreshLaunch(launch, launch, 0, 1000000), /参数/);
  assert.throws(() => assertFreshLaunch(launch, launch, 120, NaN), /参数/);
});
test("router deadline cannot extend the launch lifetime", () => {
  assert.equal(launchDeadline(launch, { number: 109n, timestamp: 1096n }, 120, 60), 1120n);
  assert.equal(launchDeadline(launch, launch, 120, 60), 1060n);
  assert.equal(configSchema.parse({}).maxLaunchAgeSeconds, 120);
  for (const value of [0, 11, 301, 1.5, Infinity])
    assert.equal(configSchema.safeParse({ maxLaunchAgeSeconds: value }).success, false);
});

test("only demonstrated age expiry is a permanent candidate rejection", () => {
  const hasCode = (code: LaunchFreshnessError["code"]) => (error: unknown) =>
    error instanceof LaunchFreshnessError && error.code === code;
  assert.throws(() => assertFreshLaunch(launch, launch, 120, 1120000), hasCode("expired"));
  assert.throws(() => assertFreshLaunch(launch, { number: 111n, timestamp: 1120n }, 120, 1110000), hasCode("expired"));
  assert.throws(() => assertFreshLaunch(launch, { number: 100n, timestamp: 988n }, 120, 1000000), hasCode("inconsistent"));
  assert.throws(() => assertFreshLaunch(launch, { number: 102n, timestamp: 999n }, 120, 1000000), hasCode("inconsistent"));
  assert.throws(() => assertFreshLaunch(launch, launch, 120, 900000), hasCode("inconsistent"));
  assert.throws(() => assertFreshLaunch(launch, launch, 0, 1000000), hasCode("invalid"));
  assert.throws(() => assertFreshLaunch(launch, launch, 120, NaN), hasCode("invalid"));
});

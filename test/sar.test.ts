import { test } from "node:test";
import assert from "node:assert/strict";
import { floodResult } from "../src/tools/sar.js";

const base = {
  validBefore: 95,
  validAfter: 92,
  thresholdDb: -17,
  dateBefore: "2024-04-01",
  dateAfter: "2024-04-20",
};

test("floodResult reports a positive delta as flooding", () => {
  const r = floodResult({ ...base, beforePct: 8.2, afterPct: 31.6 });
  assert.equal(r.floodDeltaPct, 23.4);
  assert.equal(r.waterPctBefore, 8.2);
  assert.equal(r.waterPctAfter, 31.6);
  assert.equal(r.lowQuality, false);
  assert.match(r.interpretation, /increased by 23\.4 pts/);
  assert.match(r.interpretation, /suggests flooding/);
});

test("floodResult reports a negative delta as receding water, no flood note", () => {
  const r = floodResult({ ...base, beforePct: 40, afterPct: 25 });
  assert.equal(r.floodDeltaPct, -15);
  assert.match(r.interpretation, /receded by 15 pts/);
  assert.ok(!/suggests flooding/.test(r.interpretation));
});

test("floodResult rounds the delta to one decimal place", () => {
  const r = floodResult({ ...base, beforePct: 10.04, afterPct: 12.39 });
  assert.equal(r.floodDeltaPct, 2.4); // 2.35 → 2.4
});

test("floodResult flags low valid coverage on either date", () => {
  const r = floodResult({ ...base, validAfter: 40, beforePct: 5, afterPct: 9 });
  assert.equal(r.lowQuality, true);
  assert.match(r.interpretation, /Low valid coverage/);
});

test("floodResult handles an unchanged extent", () => {
  const r = floodResult({ ...base, beforePct: 12, afterPct: 12 });
  assert.equal(r.floodDeltaPct, 0);
  assert.match(r.interpretation, /was unchanged/);
});

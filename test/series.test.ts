import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annualMean,
  decimate,
  linearTrend,
  monthlyMean,
  summarize,
  yearFraction,
} from "../src/series.js";

test("yearFraction handles dates, months, and years", () => {
  assert.equal(yearFraction("2024"), 2024.5); // bare year → mid-year
  assert.ok(Math.abs(yearFraction("2024-07") - 2024.5) < 0.05);
  assert.ok(yearFraction("2024-12-31") > 2024.9);
});

test("linearTrend recovers a known slope", () => {
  // 0.1 per year exactly, on Jan 1 of each year.
  const pts = Array.from({ length: 11 }, (_, i) => ({ t: `${2010 + i}-01-01`, v: 5 + 0.1 * i }));
  const tr = linearTrend(pts);
  assert.ok(tr);
  assert.ok(Math.abs(tr.perYear - 0.1) < 0.001, `perYear ${tr.perYear}`);
  assert.ok(Math.abs(tr.perDecade - 1.0) < 0.01);
});

test("linearTrend ignores nulls and needs ≥3 points", () => {
  assert.equal(linearTrend([{ t: "2020", v: 1 }, { t: "2021", v: 2 }]), null);
  const tr = linearTrend([
    { t: "2020-01-01", v: 0 },
    { t: "2021-01-01", v: null },
    { t: "2022-01-01", v: 2 },
    { t: "2024-01-01", v: 4 },
  ]);
  assert.ok(tr);
  assert.equal(tr.n, 3);
});

test("decimate keeps first and last and respects maxN", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => ({ t: `2020-01-01`, v: i }));
  const out = decimate(pts, 100);
  assert.ok(out.length <= 101);
  assert.equal(out[0]!.v, 0);
  assert.equal(out[out.length - 1]!.v, 999);
  assert.deepEqual(decimate(pts.slice(0, 50), 100), pts.slice(0, 50));
});

test("summarize computes range, mean, latest over non-null values", () => {
  const s = summarize([
    { t: "2020-01", v: 1 },
    { t: "2020-02", v: null },
    { t: "2020-03", v: 3 },
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.min, 1);
  assert.equal(s.max, 3);
  assert.equal(s.mean, 2);
  assert.deepEqual(s.latest, { t: "2020-03", v: 3 });
});

test("monthlyMean and annualMean aggregate daily points", () => {
  const daily = [
    { t: "2020-01-01", v: 10 },
    { t: "2020-01-02", v: 20 },
    { t: "2020-02-01", v: 30 },
    { t: "2021-01-01", v: 40 },
  ];
  assert.deepEqual(monthlyMean(daily), [
    { t: "2020-01", v: 15 },
    { t: "2020-02", v: 30 },
    { t: "2021-01", v: 40 },
  ]);
  assert.deepEqual(annualMean(daily), [
    { t: "2020", v: 20 },
    { t: "2021", v: 40 },
  ]);
});

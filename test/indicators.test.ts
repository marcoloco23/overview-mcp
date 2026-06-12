import { test } from "node:test";
import assert from "node:assert/strict";
import {
  co2Series,
  dayOfYear,
  ensoPhase,
  oniSeries,
  parseCo2,
  parseGistemp,
  parseOni,
  parseSeaIce,
  parseSeaIceClimatology,
  seaIceStatus,
} from "../src/clients/indicators.js";

// Fixtures mirror the live formats grounded on 2026-06-12.

const ONI_TEXT = ` SEAS  YR   TOTAL   ANOM
  DJF 1950  24.72  -1.53
  JFM 1950  25.17  -1.34
  NDJ 2025  27.10   0.30
  DJF 2026  26.90   0.60
  JFM 2026  27.20   0.70
`;

test("parseOni parses the CPC fixed-width table", () => {
  const rows = parseOni(ONI_TEXT);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { season: "DJF", year: 1950, total: 24.72, anom: -1.53 });
  assert.equal(rows[4]!.anom, 0.7);
});

test("ensoPhase: warm run below 5 seasons is El Niño but not an official event", () => {
  const p = ensoPhase(parseOni(ONI_TEXT));
  assert.equal(p.phase, "El Niño");
  assert.equal(p.consecutiveSeasons, 2);
  assert.equal(p.meetsEventDefinition, false);
});

test("ensoPhase: 5+ cold seasons meet the La Niña event definition", () => {
  const rows = ["MJJ", "JJA", "JAS", "ASO", "SON", "OND"].map((season, i) => ({
    season,
    year: 2024,
    total: 25,
    anom: -0.6 - i * 0.1,
  }));
  const p = ensoPhase(rows);
  assert.equal(p.phase, "La Niña");
  assert.equal(p.consecutiveSeasons, 6);
  assert.equal(p.meetsEventDefinition, true);
});

test("ensoPhase: |ONI| < 0.5 is Neutral", () => {
  const p = ensoPhase([{ season: "JFM", year: 2026, total: 26, anom: 0.3 }]);
  assert.equal(p.phase, "Neutral");
});

test("oniSeries maps seasons to their middle month", () => {
  const s = oniSeries(parseOni(ONI_TEXT));
  assert.equal(s[0]!.t, "1950-01"); // DJF → Jan
  assert.equal(s[s.length - 1]!.t, "2026-02"); // JFM → Feb
});

const CO2_TEXT = `# comment line
# year month decimal average deseasonalized ndays sdev unc
 1958    3   1958.2027      315.71      314.44     -1   -9.99   -0.99
 1958    6   1958.4548       -9.99      315.00     -1   -9.99   -0.99
 2026    5   2026.3750      432.34      429.14     17    0.66    0.31
`;

test("parseCo2 skips comments and missing (-9.99) months", () => {
  const rows = parseCo2(CO2_TEXT);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.average, 432.34);
  assert.deepEqual(co2Series(rows)[0], { t: "1958-03", v: 315.71 });
});

const GISTEMP_CSV = `Land-Ocean: Global Means
Year,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec,J-D,D-N,DJF,MAM,JJA,SON
1880,-.19,-.25,-.10,-.17,-.10,-.22,-.19,-.11,-.15,-.24,-.23,-.19,-.18,***,***,-.12,-.17,-.21
2026,1.08,1.24,1.32,1.17,1.12,***,***,***,***,***,***,***,***,***,1.13,1.20,***,***
`;

test("parseGistemp reads monthly + annual and skips ***", () => {
  const g = parseGistemp(GISTEMP_CSV);
  assert.equal(g.monthly.length, 12 + 5); // 1880 full + 2026 Jan–May
  assert.deepEqual(g.monthly[0], { t: "1880-01", v: -0.19 });
  assert.deepEqual(g.monthly[g.monthly.length - 1], { t: "2026-05", v: 1.12 });
  assert.deepEqual(g.annual, [{ t: "1880", v: -0.18 }]); // 2026 J-D is ***
});

const ICE_CSV = `Year, Month, Day,     Extent,    Missing, Source Data
YYYY,    MM,  DD, 10^6 sq km, 10^6 sq km, Source data product web sites
1978,    10,  26,     10.231,      0.000, ['/ecs/x.bin']
2026,    06,  11,     10.759,      0.000,"['/a.nc', '/b.nc']"
`;

const ICE_CLIM_CSV = `std Years = 1981-2010
DOY,   Average Extent,   Std Deviation,      10th,      25th,      50th,      75th,      90th
001,           13.778,           0.407,    13.183,    13.479,    13.823,    14.095,    14.257
162,           11.500,           0.300,    11.000,    11.200,    11.500,    11.800,    12.000
`;

test("parseSeaIce + climatology + status compute the anomaly", () => {
  const daily = parseSeaIce(ICE_CSV);
  assert.equal(daily.length, 2);
  assert.deepEqual(daily[1], { t: "2026-06-11", v: 10.759 });
  const clim = parseSeaIceClimatology(ICE_CLIM_CSV);
  assert.equal(clim.length, 2);
  assert.equal(dayOfYear("2026-06-11"), 162);
  const st = seaIceStatus("north", daily, clim);
  assert.equal(st.latest.v, 10.759);
  assert.equal(st.anomalyVsAverage, -0.741); // 10.759 − 11.5
  assert.equal(st.belowP10, true);
});

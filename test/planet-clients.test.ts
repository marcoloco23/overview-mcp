// Offline tests for the ERDDAP (OISST), Open-Meteo, and USGS clients — network mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseErddapSeries, oisstSeries } from "../src/clients/erddap.js";
import { omSeries, omUnit, archiveDaily, riverDischarge } from "../src/clients/openmeteo.js";
import { parseQuakes, quakes } from "../src/clients/usgs.js";
import { jsonResponse, mockFetch, textResponse } from "./helpers.js";

const ERDDAP_JSON = {
  table: {
    columnNames: ["time", "zlev", "latitude", "longitude", "sst"],
    columnTypes: ["String", "float", "float", "float", "float"],
    columnUnits: ["UTC", "m", "degrees_north", "degrees_east", "degree_C"],
    rows: [
      ["1985-01-01T12:00:00Z", 0, -2.625, -140.125, 25.12],
      ["1985-01-02T12:00:00Z", 0, -2.625, -140.125, null],
      ["1985-01-03T12:00:00Z", 0, -2.625, -140.125, 25.2],
    ],
  },
};

test("parseErddapSeries extracts time/value with null gaps", () => {
  const pts = parseErddapSeries(ERDDAP_JSON, "sst");
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[0], { t: "1985-01-01", v: 25.12 });
  assert.equal(pts[1]!.v, null);
});

test("parseErddapSeries rejects unexpected shapes", () => {
  assert.throws(() => parseErddapSeries({ nope: true }, "sst"));
  assert.throws(() => parseErddapSeries(ERDDAP_JSON, "missing_var"));
});

test("oisstSeries clamps the end date to the dataset's latest and strides long windows", async (t) => {
  const fm = mockFetch((url) => {
    if (url.includes("(last)")) {
      return jsonResponse({
        table: { columnNames: ["time", "zlev", "latitude", "longitude", "sst"], rows: [["2026-05-28T12:00:00Z", 0, 0.125, 0.125, 28]] },
      });
    }
    return jsonResponse(ERDDAP_JSON);
  });
  t.after(fm.restore);
  const r = await oisstSeries({ lat: -2.5, lon: -140, start: "1985-01-01", end: "2030-01-01" });
  assert.equal(r.end, "2026-05-28"); // clamped
  assert.ok(r.strideDays > 1); // ~41 years / 400 points
  const dataUrl = fm.calls[1]!.url;
  assert.ok(dataUrl.includes(`:${r.strideDays}:`), `stride in url: ${dataUrl}`);
  assert.equal(r.gridLat, -2.625);
});

const OM_JSON = {
  daily_units: { time: "iso8601", temperature_2m_mean: "°C" },
  daily: { time: ["1950-01-01", "1950-01-02"], temperature_2m_mean: [-3.2, null] },
};

test("omSeries/omUnit read a daily block, preserving nulls", () => {
  const pts = omSeries(OM_JSON, "daily", "temperature_2m_mean");
  assert.deepEqual(pts, [
    { t: "1950-01-01", v: -3.2 },
    { t: "1950-01-02", v: null },
  ]);
  assert.equal(omUnit(OM_JSON, "daily", "temperature_2m_mean"), "°C");
  assert.throws(() => omSeries(OM_JSON, "daily", "precipitation_sum"));
});

test("archiveDaily surfaces Open-Meteo error reasons", async (t) => {
  const fm = mockFetch(() =>
    jsonResponse({ error: true, reason: "Parameter 'start_date' is out of range" }, { status: 400 }),
  );
  t.after(fm.restore);
  await assert.rejects(
    archiveDaily(52.5, 13.4, ["temperature_2m_mean"], "1900-01-01", "1900-12-31"),
    /out of range/,
  );
});

test("riverDischarge returns points + unit", async (t) => {
  const fm = mockFetch(() =>
    jsonResponse({
      daily_units: { river_discharge: "m³/s" },
      daily: { time: ["2024-01-01"], river_discharge: [3.26] },
    }),
  );
  t.after(fm.restore);
  const r = await riverDischarge(-3.1, -60, "2024-01-01", "2024-01-01");
  assert.deepEqual(r.points, [{ t: "2024-01-01", v: 3.26 }]);
  assert.equal(r.unit, "m³/s");
});

const USGS_JSON = {
  features: [
    {
      id: "us7000srcg",
      properties: { mag: 6.5, place: "20 km WSW of Balangonan, Philippines", time: 1780880111958, tsunami: 0, alert: "green", url: "https://example/eq" },
      geometry: { coordinates: [121.9, 6.1, 35.2] },
    },
    { id: "bad", properties: {}, geometry: { coordinates: null } }, // skipped
  ],
};

test("parseQuakes normalizes features and skips malformed ones", () => {
  const q = parseQuakes(USGS_JSON);
  assert.equal(q.length, 1);
  assert.equal(q[0]!.mag, 6.5);
  assert.equal(q[0]!.depthKm, 35.2);
  assert.equal(q[0]!.tsunami, false);
  assert.ok(q[0]!.time.startsWith("2026-"));
  assert.throws(() => parseQuakes({ no: "features" }));
});

test("quakes builds a bounded FDSN query from a bbox", async (t) => {
  const fm = mockFetch(() => jsonResponse(USGS_JSON));
  t.after(fm.restore);
  await quakes({ bbox: [120, 5, 125, 10], minMagnitude: 5, start: "2026-06-01", limit: 9999 });
  const url = new URL(fm.calls[0]!.url);
  assert.equal(url.searchParams.get("minlongitude"), "120");
  assert.equal(url.searchParams.get("maxlatitude"), "10");
  assert.equal(url.searchParams.get("minmagnitude"), "5");
  assert.equal(url.searchParams.get("limit"), "2000"); // capped
});

test("clients reject lat/lon out of range without a network call", async (t) => {
  const fm = mockFetch(() => textResponse("should not be called", { status: 500 }));
  t.after(fm.restore);
  await assert.rejects(oisstSeries({ lat: 91, lon: 0, start: "2020-01-01", end: "2020-02-01" }), /out of range/);
  await assert.rejects(archiveDaily(0, 999, ["temperature_2m_mean"], "2020-01-01", "2020-02-01"), /out of range/);
});

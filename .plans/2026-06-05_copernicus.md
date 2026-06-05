# Plan: Phase 3 — Copernicus core (Sentinel-2 render + indices + scene search)

**Date**: 2026-06-05
**Status**: COMPLETED (live-verified)
**Phase**: ROADMAP Phase 3

## Goal

High-res Sentinel-2 imagery and vegetation/water/burn index statistics via Copernicus
Sentinel Hub: `eo_render` (Process API), `eo_index` (Statistical API), `eo_search`
(Catalog/STAC). OAuth client-credentials with an in-process token cache.

## Background — API shapes (grounded live 2026-06-05)

- OAuth: `POST identity.dataspace.copernicus.eu/.../token`, form-encoded
  `grant_type=client_credentials` + client_id/secret → `{access_token, expires_in:1800}`.
- Process: `POST sh.dataspace.copernicus.eu/api/v1/process` → PNG. Body =
  `{input:{bounds:{bbox,properties:{crs}},data:[{type:"sentinel-2-l2a",dataFilter:{timeRange,mosaickingOrder:"leastCC"}}]},output:{width,height,responses:[{identifier:"default",format:{type:"image/png"}}]},evalscript}`.
- Statistical: `POST .../statistics`. **Gotchas: needs `dataFilter.timeRange` AND a single
  aggregation bucket AND `sampleType:"FLOAT32"` on the index output** (else empty/clamped).
  Returns `data[0].outputs.data.bands.B0.stats` (mean/min/max/stDev/percentiles).
- Catalog: `POST .../catalog/1.0.0/search` → `features[]` with `id`,
  `properties.datetime`, `properties["eo:cloud_cover"]`.
- CRS string: `http://www.opengis.net/def/crs/EPSG/0/4326`.

## Approach

- `src/clients/copernicus.ts` — `CopernicusClient` (token cache + refresh-on-401);
  `process()`, `statistics()`, `search()`. A `getCopernicus()` singleton from env creds.
- `src/evalscripts.ts` — render evalscripts (trueColor/falseColor/ndvi-colorized) + stat
  evalscripts (NDVI/NDWI/NBR, FLOAT32 + dataMask).
- `src/tools/analysis.ts` — `eo_render`, `eo_index`, `eo_search`; require CDSE creds with a
  clean error + signup link if unset.
- Dashboard: `index` feed card (stats panel + a -1..1 gradient marker) in `cards.ts`.
  `eo_render` reuses the existing `imagery` card/overlay.

## Implementation steps

- [ ] copernicus.ts (token cache, process, statistics, search)
- [ ] evalscripts.ts
- [ ] analysis.ts tools + register in index.ts
- [ ] dashboard index card
- [ ] build + LIVE-verify all three tools with CDSE creds

## Testing

- Live: `eo_render` (trueColor + ndvi) over Manaus returns a PNG; `eo_index` NDVI returns
  mean≈0.28; `eo_search` lists scenes with cloud %. No-creds path returns a clean error.
- View the rendered imagery + the index card on the dashboard (screenshot).

## Definition of done

- [ ] builds + typechecks; live-verified; ledgers updated.

## Notes / log

- 2026-06-05: API shapes grounded live (token 1800s; Process PNG of Manaus; Statistical
  NDVI mean 0.279 over 30d leastCC composite; Catalog returns scenes + cloud%).

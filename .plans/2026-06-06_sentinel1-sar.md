# Plan: Sentinel-1 SAR — `sar_render` + multi-collection Copernicus client

**Date**: 2026-06-06
**Status**: COMPLETED (offline; live S1 render + viz-gain tuning deferred — no creds/network)
**Phase**: Horizon 1 — Trustworthy analyst (VISION §6 pillar 1 "all-weather SAR"; ROADMAP item 2)

## Goal

Add **Sentinel-1 C-band SAR** backscatter rendering (`sar_render`) — all-weather imagery that
sees through cloud, smoke, and night, the start of closing our #1 weakness. Generalize the
Copernicus client so Process can target any collection (S1 GRD with terrain-correction
processing), keeping the Sentinel-2 path byte-identical.

## Background

VISION §6 pillar 1 and §9 Tier-1 call Sentinel-1 "the cloud answer"; ROADMAP Horizon 1 item 2
is the SAR toolset. Today every render funnels through a hardcoded `sentinel-2-l2a` data
input. SAR is the single biggest capability gap. Constraint: no creds/network this session,
so the live render + visualization-gain tuning are deferred — but the client generalization,
the evalscripts, the tool wiring, and SAR provenance are all offline-testable.

## Approach

- Generalize `CopernicusClient` `dataInput` → `buildInput(bbox, from, to, source)` driven by a
  `DataSourceSpec { collection, mosaickingOrder?, dataFilter?, processing?, maxCloud? }`.
  S2 callers use a default `s2Source(maxCloud)` that reproduces the *exact* current body
  (guarded by a test). SAR passes a `sentinel-1-grd` spec with `acquisitionMode: IW`,
  `polarization: DV`, `resolution: HIGH`, `processing: { orthorectify, backCoeff:
  GAMMA0_TERRAIN }`, `mosaickingOrder: mostRecent`.
- SAR has **no cloud mask** — that's the point — so a dedicated `sarProvenance()` whose
  `cloudMask.method` says "n/a — all-weather", with a SAR-specific disclaimer (speckle,
  incidence-angle/orbit sensitivity → compare like orbits).

## Implementation steps

- [x] `evalscripts.ts`: `SAR_EVALSCRIPTS` (vv, vh, falseColor=VV/VH/ratio).
- [x] `clients/copernicus.ts`: `DataSourceSpec`; refactor to `buildInput` + `s2Source`;
      thread `source?` through `ProcessOpts`. S2 body unchanged.
- [x] `provenance.ts`: `sarProvenance({bbox,from,to,polarization,orbitDirection?})`.
- [x] `tools/sar.ts`: `sar_render(bbox, date?, view?, windowDays?, orbitDirection?, width?)`
      → image + provenance + imagery card. Registered in `index.ts`; instructions updated.
- [x] Tests: evalscripts (SAR scripts), copernicus (S1 body shape + S2 unchanged), provenance.

## Files to create / modify

| File | Change |
| --- | --- |
| `src/evalscripts.ts` | SAR evalscripts + views |
| `src/clients/copernicus.ts` | `DataSourceSpec`, `buildInput`, `s2Source`, `ProcessOpts.source` |
| `src/provenance.ts` | `sarProvenance()` |
| `src/tools/sar.ts` | NEW — `sar_render` |
| `src/index.ts` | register + instructions |
| `test/*.test.ts` | SAR evalscripts, S1/S2 request body, SAR provenance |

## Testing

- `pnpm test` green (incl. new SAR tests); `pnpm typecheck:test` green; build green; MCP lists
  10 tools. Key guard: the S2 `/process` request body is **deep-equal** to before the refactor.
- Live S1 render + viz-gain tuning **deferred** (no creds/network) — noted in ledgers; gains
  are documented as a starting point to tune against real scenes.

## Risks / edge cases

- Refactor must not change the S2 body → asserted by deep-equality test (S1 + S2 both).
- SAR viz gains are unverifiable here; keep them modest + documented; structure is correct.
- `polarization: DV` provides both VV+VH so all three views work; orbitDirection optional.

## Definition of done

- [x] builds + typechecks (src + test); `pnpm test` green (57); MCP lists `sar_render` (10 tools)
- [x] CONTINUITY.md + PROGRESS.md + ROADMAP.md (+ README) updated

## Notes / log

- 2026-06-06: SAR chosen as the top offline-buildable Horizon 1 item; client generalization is
  a tested refactor, the live render/gain pass waits for creds.
- 2026-06-06: COMPLETED offline. 57 tests green incl. the S2-body-unchanged deep-equality
  guard and the S1-body-shape assertion; no-creds path returns a clean error. The viz gains in
  `SAR_EVALSCRIPTS` are a documented starting point — tune against real scenes when creds exist.

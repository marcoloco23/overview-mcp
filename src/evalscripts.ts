// Sentinel Hub evalscripts. Render scripts return an RGB visualization; stat scripts
// return a single FLOAT32 index band + dataMask for the Statistical API.

/** Visualization evalscripts for the Process API (eo_render `view`). */
export const RENDER_EVALSCRIPTS: Record<string, string> = {
  trueColor: `//VERSION=3
function setup(){return {input:["B02","B03","B04"],output:{bands:3}}}
function evaluatePixel(s){return [2.5*s.B04,2.5*s.B03,2.5*s.B02]}`,

  // Color-infrared: vegetation bright red (B08 NIR → red channel).
  falseColor: `//VERSION=3
function setup(){return {input:["B03","B04","B08"],output:{bands:3}}}
function evaluatePixel(s){return [2.5*s.B08,2.5*s.B04,2.5*s.B03]}`,

  // NDVI color ramp: blue water → tan bare → greens for increasing vegetation.
  ndvi: `//VERSION=3
function setup(){return {input:["B04","B08"],output:{bands:3}}}
function evaluatePixel(s){
  var n=(s.B08-s.B04)/(s.B08+s.B04);
  if(n<-0.2) return [0.05,0.05,0.4];
  if(n<0.0) return [0.6,0.6,0.6];
  if(n<0.2) return [0.85,0.8,0.55];
  if(n<0.4) return [0.74,0.83,0.38];
  if(n<0.6) return [0.42,0.72,0.22];
  return [0.1,0.5,0.05];
}`,
};

/**
 * Visualization evalscripts for Sentinel-1 GRD (`sar_render`). Inputs are GAMMA0
 * terrain-corrected linear backscatter (VV/VH). We apply a sqrt stretch (a cheap dB-like
 * compression of SAR's wide dynamic range) with modest gains — a sensible starting point to
 * tune against real scenes. SAR has no cloud concept: bright = rough/urban/forest, dark =
 * smooth/calm-water.
 */
export const SAR_EVALSCRIPTS: Record<string, string> = {
  // Co-pol VV backscatter, grayscale.
  vv: `//VERSION=3
function setup(){return {input:["VV"],output:{bands:3}}}
function evaluatePixel(s){var v=Math.sqrt(Math.max(0,s.VV))*1.5;return [v,v,v]}`,

  // Cross-pol VH backscatter (volume scattering → vegetation), grayscale.
  vh: `//VERSION=3
function setup(){return {input:["VH"],output:{bands:3}}}
function evaluatePixel(s){var v=Math.sqrt(Math.max(0,s.VH))*2.5;return [v,v,v]}`,

  // False color: R=VV, G=VH, B=VV/VH ratio — urban bright, vegetation greenish, water dark.
  falseColor: `//VERSION=3
function setup(){return {input:["VV","VH"],output:{bands:3}}}
function evaluatePixel(s){
  var vv=Math.max(0,s.VV), vh=Math.max(0,s.VH);
  return [Math.sqrt(vv)*1.5, Math.sqrt(vh)*2.5, (vv/(vh+1e-6))*0.1];
}`,
};

/**
 * Statistical evalscript for SAR water/flood extent. Water (and other smooth surfaces)
 * specularly reflect radar away from the sensor → very low VV backscatter, so VV γ⁰ below a
 * threshold marks water. Outputs a binary band (1 = water), so the Statistical API's `mean`
 * over the AOI is the **water-covered fraction**. `threshLinear` is the VV γ⁰ cutoff in linear
 * power (convert from dB with 10^(dB/10)).
 */
export function sarWaterEvalscript(threshLinear: number): string {
  return `//VERSION=3
function setup(){return {input:[{bands:["VV","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){
  var water=(s.VV<${threshLinear})?1:0;
  return {data:[water],dataMask:[s.dataMask]};
}`;
}

/** Normalized-difference index definitions for the Statistical API. */
const INDEX_BANDS: Record<string, [string, string]> = {
  NDVI: ["B08", "B04"], // (NIR - Red)/(NIR + Red)
  NDWI: ["B03", "B08"], // (Green - NIR)/(Green + NIR)
  NBR: ["B08", "B12"], // (NIR - SWIR)/(NIR + SWIR)
};

export const INDEX_NAMES = Object.keys(INDEX_BANDS);

/**
 * The Sentinel-2 Scene Classification (SCL) classes excluded from index statistics, kept
 * here as the SINGLE source of truth so the evalscript mask and the human-readable
 * provenance description (src/provenance.ts) can never drift apart.
 *   - `always` is masked for every index (defective, shadow, cloud, cirrus),
 *   - `waterForNonWater` (open water, class 6) is additionally masked for vegetation/burn
 *     indices so seasonal river/lake level doesn't dilute the result — but NEVER for NDWI,
 *     where water is the signal.
 * Masked pixels become noDataCount, which the tool surfaces as a "% valid" quality flag.
 */
export const SCL_CLEAR_MASK = {
  always: [
    { id: 1, label: "defective" },
    { id: 3, label: "cloud shadow" },
    { id: 8, label: "cloud (medium prob.)" },
    { id: 9, label: "cloud (high prob.)" },
    { id: 10, label: "thin cirrus" },
  ],
  waterForNonWater: { id: 6, label: "open water" },
} as const;

/**
 * The s2cloudless layer of the mask (Horizon 1 "cloud handling, rung 1"). CDSE exposes the
 * s2cloudless model as two bands on sentinel-2-l2a: CLM (binary cloud mask, 160 m) and CLP
 * (cloud probability, 0–255). SCL and s2cloudless fail differently — SCL catches shadows
 * s2cloudless doesn't flag, s2cloudless catches the haze and small cumulus SCL misses — so
 * the stat mask excludes a pixel if EITHER flags it. Like SCL_CLEAR_MASK, this constant is
 * the single source of truth shared by the evalscript and the provenance description.
 */
export const S2CLOUDLESS_MASK = {
  clpCutoff: 102, // CLP ≥ 102/255 ≈ 40 % cloud probability → masked
  label: "s2cloudless cloud (CLM=1 or CLP≥40%)",
} as const;

/** Human-readable description of the per-pixel mask method (drives the provenance block). */
export const STAT_MASK_METHOD =
  "Sentinel-2 SCL + s2cloudless (CLM/CLP) per-pixel mask — a pixel is excluded if either flags it";

/** The human-readable classes masked for a given index (drives the provenance block). */
export function maskedClassesFor(index: string): string[] {
  const labels = SCL_CLEAR_MASK.always.map((c) => `${c.label} (SCL ${c.id})`);
  if (index !== "NDWI") {
    const w = SCL_CLEAR_MASK.waterForNonWater;
    labels.push(`${w.label} (SCL ${w.id})`);
  }
  labels.push(S2CLOUDLESS_MASK.label);
  return labels;
}

/** Build a FLOAT32 + dataMask stat evalscript for a normalized-difference index. */
export function statEvalscript(index: string): string {
  const pair = INDEX_BANDS[index];
  if (!pair) throw new Error(`unknown index '${index}'. Options: ${INDEX_NAMES.join(", ")}`);
  const [a, b] = pair;
  const ids: number[] = SCL_CLEAR_MASK.always.map((c) => c.id);
  if (index !== "NDWI") ids.push(SCL_CLEAR_MASK.waterForNonWater.id);
  const scl = ids.map((id) => `s.SCL!==${id}`).join(" && ");
  const clear = `${scl} && s.CLM!==1 && s.CLP<${S2CLOUDLESS_MASK.clpCutoff}`;
  return `//VERSION=3
function setup(){return {input:[{bands:["${a}","${b}","SCL","CLM","CLP","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){
  var v=(s.${a}-s.${b})/(s.${a}+s.${b});
  var clear=(${clear})?1:0;
  return {data:[v],dataMask:[s.dataMask*clear]};
}`;
}

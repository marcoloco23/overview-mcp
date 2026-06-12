// Hand-rolled SVG time-series chart for `series` cards — no charting dependency.
// Built entirely from DOM nodes/textContent (payload values originate from upstream APIs).

export interface SeriesData {
  label: string;
  unit: string;
  points: Array<{ t: string; v: number | null }>;
}

const W = 320;
const H = 132;
const PAD = { top: 8, right: 8, bottom: 18, left: 42 };
const LINE_COLORS = ["#38bdf8", "#94a3b8", "#f472b6"];
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Epoch ms for an ISO date / YYYY-MM / hourly stamp; NaN-safe enough for plotting. */
function timeOf(t: string): number {
  const full = t.length === 7 ? `${t}-15` : t.length === 4 ? `${t}-07-01` : t;
  const ms = Date.parse(full.includes("T") ? full : `${full}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : 0;
}

function fmtValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * Render up to 3 series as an SVG line chart with min/max y labels, first/last x labels,
 * optional dashed horizontal threshold lines, and a small legend when there are ≥2 lines.
 */
export function renderChart(seriesArr: SeriesData[], thresholds: number[] = []): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  const lines = seriesArr.slice(0, 3).filter((s) => Array.isArray(s.points) && s.points.length > 0);
  if (lines.length === 0) return wrap;

  let tMin = Infinity;
  let tMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const s of lines) {
    for (const p of s.points) {
      const tm = timeOf(p.t);
      if (tm < tMin) tMin = tm;
      if (tm > tMax) tMax = tm;
      if (p.v === null || !Number.isFinite(p.v)) continue;
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }
  }
  for (const th of thresholds) {
    if (th < vMin) vMin = th;
    if (th > vMax) vMax = th;
  }
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) return wrap;
  if (vMax === vMin) {
    vMax += 1;
    vMin -= 1;
  }
  const spanT = Math.max(1, tMax - tMin);
  const spanV = vMax - vMin;
  const x = (t: number) => PAD.left + ((t - tMin) / spanT) * (W - PAD.left - PAD.right);
  const y = (v: number) => H - PAD.bottom - ((v - vMin) / spanV) * (H - PAD.top - PAD.bottom);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "chart-svg",
    role: "img",
  });

  // Threshold lines (e.g. ±0.5 ONI, 1.5 °C) — dashed, behind the data.
  for (const th of thresholds) {
    svg.appendChild(
      svgEl("line", {
        x1: String(PAD.left),
        x2: String(W - PAD.right),
        y1: String(y(th)),
        y2: String(y(th)),
        class: "chart-threshold",
      }),
    );
  }

  // Data lines: one path per series, broken at null gaps.
  lines.forEach((s, i) => {
    let d = "";
    let pen = false;
    for (const p of s.points) {
      if (p.v === null || !Number.isFinite(p.v)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(timeOf(p.t)).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    }
    const path = svgEl("path", { d, class: "chart-line" });
    path.style.stroke = LINE_COLORS[i % LINE_COLORS.length]!;
    if (i > 0) path.style.opacity = "0.65";
    svg.appendChild(path);
  });

  // Axis labels: y min/max, x first/last.
  const label = (tx: number, ty: number, text: string, anchor: string) => {
    const t = svgEl("text", { x: String(tx), y: String(ty), class: "chart-label", "text-anchor": anchor });
    t.textContent = text;
    svg.appendChild(t);
  };
  label(PAD.left - 4, y(vMax) + 4, fmtValue(vMax), "end");
  label(PAD.left - 4, y(vMin) + 4, fmtValue(vMin), "end");
  const t0 = lines[0]!.points[0]!.t;
  const t1 = lines[0]!.points[lines[0]!.points.length - 1]!.t;
  label(PAD.left, H - 4, t0.slice(0, 10), "start");
  label(W - PAD.right, H - 4, t1.slice(0, 10), "end");

  wrap.appendChild(svg);

  if (lines.length > 1) {
    const legend = document.createElement("div");
    legend.className = "chart-legend";
    lines.forEach((s, i) => {
      const item = document.createElement("span");
      const dot = document.createElement("span");
      dot.className = "chart-dot";
      dot.style.background = LINE_COLORS[i % LINE_COLORS.length]!;
      item.append(dot, document.createTextNode(` ${s.label}`));
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
  }
  return wrap;
}

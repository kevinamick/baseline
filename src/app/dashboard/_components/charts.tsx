"use client";

/* Hand-built SVG chart primitives so they inherit the brand exactly: Geist Mono
   numerals, yellow accent for the focused series, warm hairline gridlines.
   Ported from the Baseline design-system mockup (dashboard/Charts.jsx). */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DAY_MS,
  fmtDay,
  fmtDayShort,
  pct,
  type DashRubric,
  type DashRun,
} from "../_lib/dashboard-data";

const MONO = "var(--font-geist-mono)";

interface Pt {
  x: number;
  y: number;
  t: number;
  score: number;
  rubricId: string;
  rubricName: string;
  runNo: number;
}

// Measure a container's pixel width (charts need explicit coords, not %).
function useMeasure() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0].contentRect.width;
      if (cw > 0) setW(cw);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// Catmull-Rom → cubic-bezier smooth path.
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return pts.length ? `M${pts[0].x},${pts[0].y}` : "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
}

// ===========================================================================
// Hero: score-over-time line chart
// ===========================================================================
export function ScoreTimeChart({
  rubrics,
  runs,
  rangeDays,
  today,
  visible,
  focusedId,
  onSelect,
  accent = "#FFE066",
}: {
  rubrics: DashRubric[];
  runs: DashRun[];
  rangeDays: number;
  today: number;
  visible: Set<string>;
  focusedId: string | null;
  onSelect?: (rubricId: string) => void;
  accent?: string;
}) {
  const [ref, width] = useMeasure();
  const [hover, setHover] = useState<(Pt & { tone: string }) | null>(null);

  const H = 360;
  const pad = { t: 18, r: 22, b: 34, l: 40 };
  const innerW = Math.max(120, width - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;

  const t1 = today;
  const t0 = today - rangeDays * DAY_MS;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * innerW;

  // Tighten the y-axis to the data range so trends fill the panel instead of
  // floating above a large empty 0–50% expanse.
  let dataMin = 1;
  runs.forEach((run) => {
    if (run.score != null && run.t >= t0 && run.t <= t1 && run.score < dataMin) {
      dataMin = run.score;
    }
  });
  const yMin = Math.max(0, Math.min(0.4, Math.floor((dataMin - 0.05) * 10) / 10));
  const yMax = 1;
  const y = (s: number) => pad.t + (1 - (s - yMin) / (yMax - yMin)) * innerH;
  const yBottom = y(yMin);

  // Build per-series point arrays (completed, scored runs within range only).
  const runsByRubric = useMemo(() => {
    const m = new Map<string, DashRun[]>();
    runs.forEach((r) => {
      const arr = m.get(r.rubricId) ?? [];
      arr.push(r);
      m.set(r.rubricId, arr);
    });
    return m;
  }, [runs]);

  const seriesPts = useMemo(
    () =>
      rubrics.map((r) => {
        const pts: Pt[] = (runsByRubric.get(r.id) ?? [])
          .filter((run) => run.score != null && run.t >= t0 && run.t <= t1)
          .map((run) => ({
            x: x(run.t),
            y: y(run.score as number),
            t: run.t,
            score: run.score as number,
            rubricId: r.id,
            rubricName: r.name,
            runNo: run.runNo,
          }));
        return { rubric: r, pts };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rubrics, runsByRubric, rangeDays, width, today]
  );

  const ticks = [...new Set([1, 0.8, 0.6, 0.5, 0.4, yMin].filter((v) => v >= yMin - 1e-6))].sort(
    (a, b) => a - b
  );
  const xTickCount = rangeDays <= 7 ? 7 : 6;
  const xTicks = Array.from(
    { length: xTickCount },
    (_, i) => t0 + ((t1 - t0) * i) / (xTickCount - 1)
  );

  // Nearest visible data point to the cursor, within a grab radius (else null).
  function nearestPoint(e: React.MouseEvent<SVGSVGElement>): (Pt & { tone: string }) | null {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: (Pt & { tone: string }) | null = null;
    let bestD = Infinity;
    seriesPts.forEach(({ rubric, pts }) => {
      if (!visible.has(rubric.id)) return;
      pts.forEach((p) => {
        const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { ...p, tone: rubric.tone };
        }
      });
    });
    return best && bestD < 60 * 60 ? best : null;
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    setHover(nearestPoint(e));
  }

  // Clicking a point focuses its rubric — even when it belongs to another series.
  function onClick(e: React.MouseEvent<SVGSVGElement>) {
    const hit = nearestPoint(e);
    if (hit) onSelect?.(hit.rubricId);
  }

  const hoverHex = hover
    ? hover.score >= 0.8
      ? "#34D399"
      : hover.score >= 0.5
        ? "#FBBF24"
        : "#F87171"
    : "#fff";

  return (
    <div ref={ref} style={{ width: "100%", position: "relative" }}>
      <svg
        width={width}
        height={H}
        style={{ display: "block", overflow: "visible", cursor: hover ? "pointer" : "default" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
      >
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.32" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* threshold guide bands: pass (≥80) and fail (<50) */}
        <rect x={pad.l} y={y(1)} width={innerW} height={y(0.8) - y(1)} fill="#059669" opacity="0.05" />
        <rect x={pad.l} y={y(0.5)} width={innerW} height={yBottom - y(0.5)} fill="#DC2626" opacity="0.045" />

        {/* gridlines + y labels */}
        {ticks.map((s) => (
          <g key={s}>
            <line
              x1={pad.l}
              y1={y(s)}
              x2={pad.l + innerW}
              y2={y(s)}
              stroke={s === 0.5 || s === 0.8 ? "#C9C0A0" : "#EDE6CB"}
              strokeWidth="1"
              strokeDasharray={s === 0.5 || s === 0.8 ? "4 4" : ""}
            />
            <text
              x={pad.l - 10}
              y={y(s) + 4}
              textAnchor="end"
              fontFamily={MONO}
              fontSize="11"
              fill="#A1A1AA"
              style={{ fontFeatureSettings: "'tnum'" }}
            >
              {pct(s)}
            </text>
          </g>
        ))}

        {/* x labels */}
        {xTicks.map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={H - 10}
            textAnchor="middle"
            fontFamily={MONO}
            fontSize="11"
            fill="#A1A1AA"
            style={{ fontFeatureSettings: "'tnum'" }}
          >
            {fmtDayShort(t)}
          </text>
        ))}

        {/* context series (non-focused), drawn first */}
        {seriesPts.map(({ rubric, pts }) => {
          if (!visible.has(rubric.id) || rubric.id === focusedId || pts.length === 0) return null;
          return (
            <path
              key={rubric.id}
              d={smoothPath(pts)}
              fill="none"
              stroke={rubric.tone}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={focusedId ? 0.45 : 0.85}
            />
          );
        })}

        {/* focused series, drawn on top: ink line + yellow markers */}
        {seriesPts.map(({ rubric, pts }) => {
          if (rubric.id !== focusedId || !visible.has(rubric.id) || pts.length === 0) return null;
          const path = smoothPath(pts);
          return (
            <g key={rubric.id}>
              <path
                d={path}
                fill="none"
                stroke="#0E0E10"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={3.5} fill={accent} stroke="#0E0E10" strokeWidth="1.5" />
              ))}
            </g>
          );
        })}

        {/* hover crosshair + marker */}
        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.x}
              y1={pad.t}
              x2={hover.x}
              y2={pad.t + innerH}
              stroke="#0E0E10"
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.3"
            />
            <circle cx={hover.x} cy={hover.y} r="6" fill={accent} stroke="#0E0E10" strokeWidth="2" />
          </g>
        )}
      </svg>

      {hover && (
        <div
          style={{
            position: "absolute",
            left: Math.min(Math.max(hover.x - 70, 0), width - 150),
            top: hover.y - 70,
            background: "#0E0E10",
            color: "#fff",
            borderRadius: 12,
            padding: "9px 12px",
            pointerEvents: "none",
            boxShadow: "0 16px 32px -8px rgba(60,45,0,0.10)",
            minWidth: 132,
            zIndex: 5,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: "#A1A1AA",
              marginBottom: 4,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {hover.rubricName}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: hoverHex }}>
              {pct(hover.score)}%
            </span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: "#A1A1AA" }}>{fmtDay(hover.t)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Sparkline — tiny trend for leaderboard rows
// ===========================================================================
export function Sparkline({
  series,
  width = 96,
  height = 30,
  color = "#0E0E10",
  accent = "#FFE066",
}: {
  series: DashRun[];
  width?: number;
  height?: number;
  color?: string;
  accent?: string;
}) {
  const pts = series.filter((r) => r.score != null);
  if (pts.length < 2) return <svg width={width} height={height} />;
  const scores = pts.map((p) => p.score as number);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const rng = Math.max(0.08, max - min);
  const X = (i: number) => (i / (pts.length - 1)) * (width - 4) + 2;
  const Y = (s: number) => height - 3 - ((s - min) / rng) * (height - 6);
  const coords = pts.map((p, i) => ({ x: X(i), y: Y(p.score as number) }));
  const last = coords[coords.length - 1];
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <path
        d={smoothPath(coords)}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      <circle cx={last.x} cy={last.y} r="2.75" fill={accent} stroke={color} strokeWidth="1.25" />
    </svg>
  );
}

// ===========================================================================
// Status mix — horizontal stacked bar of run statuses
// ===========================================================================
export function StatusMix({ counts }: { counts: Record<string, number> }) {
  const order = [
    { key: "completed", label: "Completed", color: "#059669" },
    { key: "running", label: "Running", color: "#2563EB" },
    { key: "queued", label: "Queued", color: "#A1A1AA" },
    { key: "failed", label: "Failed", color: "#DC2626" },
    { key: "skipped", label: "Skipped", color: "#D4D4D8" },
  ];
  const total = order.reduce((a, o) => a + (counts[o.key] || 0), 0) || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", height: 12, borderRadius: 9999, overflow: "hidden", gap: 2 }}>
        {order.map((o) => {
          const c = counts[o.key] || 0;
          if (!c) return null;
          return (
            <div
              key={o.key}
              style={{ width: `${(c / total) * 100}%`, background: o.color, borderRadius: 9999 }}
              title={`${o.label}: ${c}`}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px" }}>
        {order.map((o) => (
          <div key={o.key} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 8, height: 8, borderRadius: 9999, background: o.color }} />
            <span style={{ fontSize: 12, color: "#3F3F46" }}>{o.label}</span>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 12,
                fontWeight: 600,
                color: "#0E0E10",
                fontFeatureSettings: "'tnum'",
              }}
            >
              {counts[o.key] || 0}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";
import { ArrowLeft, ChevronDown, ChevronUp, Minus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PatientDetail, Vital } from "@/lib/model";
import {
  duration, formatVital, mergeSamples, metricCatalog, metricTitle,
  type AppDisplayValue, type HistoryCursor, type VitalSummary, type VitalsOverview, type VitalsPage,
} from "@/lib/vitals";
import {
  allBucket, bucketRows, categories, intervalKinds, isoWeek, lastDays, rowsFromVitals, seriesFor, sumKinds, summarize, trendDelta,
  type Bucket, type DayPoint, type TrendResponse,
} from "@/lib/vitals-trend";
import "./vitals-view.css";

async function request(body: unknown) {
  const response = await fetch("/api/clinical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "Mätningarna kunde inte hämtas."), { status: response.status });
  return result;
}

// Transient failures (network, 5xx) are retried quietly so the user does not have to press Uppdatera repeatedly.
async function withRetry<T>(task: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await task();
    } catch (e) {
      last = e;
      const status = (e as { status?: number }).status;
      if (status !== undefined && status < 500) break;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

function LoadBar({ loading, done, total }: { loading: boolean; done: number; total: number }) {
  const [p, setP] = useState(0);
  const [visible, setVisible] = useState(false);
  const ceiling = useRef(0);
  ceiling.current = 55 + (done / total) * 40;
  useEffect(() => {
    if (loading) {
      setVisible(true);
      setP(8);
      const id = setInterval(() => setP((v) => v + (ceiling.current - v) * 0.1), 120);
      return () => clearInterval(id);
    }
    setP(100);
    const t = setTimeout(() => { setVisible(false); setP(0); }, 600);
    return () => clearTimeout(t);
  }, [loading]);
  if (!visible) return null;
  const label = loading ? (done === 0 ? "Hämtar mätvärden…" : "Hämtar trender…") : "Klart";
  return (
    <div className="vt-load" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
      <div className="vt-load-track"><div className="vt-load-fill" style={{ width: `${p}%` }} /></div>
      <span>{label}</span>
    </div>
  );
}
const time = (date: string) => new Date(date).toLocaleString("sv-SE");
const shortDay = (day: string) => new Date(day + "T12:00:00Z").toLocaleDateString("sv-SE", { day: "numeric", month: "short", timeZone: "UTC" });
const number = (value: number) => new Intl.NumberFormat("sv-SE", { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 }).format(value);

function ago(iso: string) {
  const minutes = (Date.now() - Date.parse(iso)) / 60000;
  if (minutes < 2) return "nyss";
  if (minutes < 60) return `${Math.round(minutes)} min sedan`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} tim sedan`;
  if (minutes < 60 * 48) return "i går";
  return `${Math.round(minutes / 1440)} dagar sedan`;
}
function unitFor(kind: string, fallback = "") {
  return metricCatalog.find(([k]) => k === kind)?.[2] ?? fallback;
}
function valueText(kind: string, value: number, unit: string) {
  if (intervalKinds.has(kind)) return duration(value);
  return `${number(value)} ${unit}`.trim();
}

const ranges = [
  { value: 7, label: "7 dagar" },
  { value: 30, label: "30 dagar" },
  { value: 90, label: "90 dagar" },
  { value: 365, label: "1 år" },
  { value: "all", label: "Allt" },
] as const;
type Range = (typeof ranges)[number]["value"];
type LongKey = "year" | "all";

/** What a tile or detail view draws for the chosen period. */
type Resolved = { points: DayPoint[]; bucket: Bucket; fallback: string | null; pending: boolean; failed: boolean };

function bucketLabel(day: string, bucket: Bucket) {
  if (bucket === "month") return new Date(day + "T12:00:00Z").toLocaleDateString("sv-SE", { month: "short", year: "numeric", timeZone: "UTC" });
  if (bucket === "week") {
    const w = isoWeek(day);
    return `v. ${w.week} ${w.year}`;
  }
  return shortDay(day);
}
const bucketWord: Record<Bucket, string> = { day: "dag", week: "vecka", month: "månad" };
function rangeText(range: Range) {
  return range === "all" ? "all historik" : range === 365 ? "1 år" : `${range} dagar`;
}

export function VitalsWorkspace({ detail, demo, onRefresh }: { detail: PatientDetail; demo: boolean; onRefresh: () => Promise<void> }) {
  const [overview, setOverview] = useState<VitalsOverview | null>(null);
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [long, setLong] = useState<Record<LongKey, TrendResponse | null>>({ year: null, all: null });
  const [longError, setLongError] = useState<Record<LongKey, boolean>>({ year: false, all: false });
  const [error, setError] = useState("");
  const [overviewError, setOverviewError] = useState("");
  const [trendError, setTrendError] = useState("");
  const [done, setDone] = useState(0);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>(30);
  const [selected, setSelected] = useState<string | null>(null);
  const patientRef = useRef(detail.patient.id);
  const demoVitals = demo ? detail.vitals : undefined;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setDone(0);
    setError("");
    setOverviewError("");
    setTrendError("");
    if (patientRef.current !== detail.patient.id) {
      patientRef.current = detail.patient.id;
      setOverview(null);
      setTrend(null);
    }
    setLong({ year: null, all: null });
    setLongError({ year: false, all: false });
    const loadOverview = (): Promise<VitalsOverview> => demo
      ? Promise.resolve({
          metrics: metricCatalog.flatMap(([kind]) => {
            const values = detail.vitals.filter((v) => v.kind === kind).sort((a, b) => b.end_at.localeCompare(a.end_at));
            return values.length ? [{ kind, count: values.length, first_at: values.at(-1)!.start_at, last_at: values[0].end_at, latest: values[0] }] : [];
          }),
          sleep_night: null,
        })
      : request({ action: "vitals_overview", patientId: detail.patient.id });
    const loadTrend = (): Promise<TrendResponse> => demo
      ? Promise.resolve({ days: 90, series: rowsFromVitals(detail.vitals) })
      : request({ action: "vitals_trend", patientId: detail.patient.id, days: 90 });
    // Each part loads and fails on its own, so one failure never blanks the whole view.
    const overviewTask = withRetry(loadOverview)
      .then((o) => { if (active) setOverview(o); })
      .catch((e) => { if (active) setOverviewError(e.message || "Mätvärdena kunde inte hämtas."); })
      .finally(() => { if (active) setDone((d) => d + 1); });
    const trendTask = withRetry(loadTrend)
      .then((t) => { if (active) setTrend(t); })
      .catch(() => { if (active) setTrendError("Trenderna kunde inte hämtas."); })
      .finally(() => { if (active) setDone((d) => d + 1); });
    Promise.all([overviewTask, trendTask]).then(() => { if (active) setLoading(false); });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.patient.id, demo, version, demoVitals]);

  // Long ranges load on their own: the full history in the background (it also backs tiles without recent data),
  // the past year when that period is chosen. Daily data and the overview are never held up by them.
  const firstAt = overview?.metrics.map((m) => m.first_at).sort()[0];
  const wantYear = range === 365;
  const longToken = useRef("");
  const inflight = useRef(new Set<LongKey>());
  useEffect(() => {
    if (!overview || loading) return;
    // Results from an earlier patient or refresh are ignored; each period is requested once per refresh.
    const token = detail.patient.id + ":" + version;
    if (longToken.current !== token) {
      longToken.current = token;
      inflight.current.clear();
    }
    const load = (key: LongKey) => {
      if (long[key] || longError[key] || inflight.current.has(key)) return;
      inflight.current.add(key);
      const days = key === "year" ? 365
        : Math.min(40000, Math.max(1, Math.ceil((Date.now() - Date.parse(firstAt ?? new Date().toISOString())) / 86400000) + 1));
      const bucket: Bucket = key === "year" ? "week" : allBucket(days);
      const task: Promise<TrendResponse> = demo
        ? Promise.resolve({ days, bucket, series: bucketRows(rowsFromVitals(detail.vitals), bucket) })
        : withRetry(() => request({ action: "vitals_trend", patientId: detail.patient.id, days, bucket }));
      task
        .then((t) => { if (longToken.current === token) setLong((l) => ({ ...l, [key]: t })); })
        .catch(() => { if (longToken.current === token) setLongError((e) => ({ ...e, [key]: true })); })
        .finally(() => { if (longToken.current === token) inflight.current.delete(key); });
    };
    load("all");
    if (wantYear) load("year");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, loading, wantYear, long, longError, version, detail.patient.id]);

  function resolve(kind: string): Resolved {
    const monthly = seriesFor(long.all?.series ?? [], kind);
    const allBucketUsed: Bucket = long.all?.bucket ?? "month";
    let points: DayPoint[];
    let bucket: Bucket;
    let pending = false;
    let failed = false;
    if (range === "all") {
      points = monthly; bucket = allBucketUsed; pending = !long.all && !longError.all; failed = longError.all;
    } else if (range === 365) {
      points = seriesFor(long.year?.series ?? [], kind); bucket = "week"; pending = !long.year && !longError.year; failed = longError.year;
    } else {
      points = lastDays(seriesFor(trend?.series ?? [], kind), range); bucket = "day"; failed = !!trendError && !trend;
    }
    // A metric without data in the period still shows its trend from the time it was measured.
    if (!pending && points.length < 2 && range !== "all" && monthly.length >= 2) {
      const from = monthly[0].day.slice(0, 4);
      const to = monthly[monthly.length - 1].day.slice(0, 4);
      return { points: monthly, bucket: allBucketUsed, fallback: `${from === to ? from : `${from}–${to}`} · per ${bucketWord[allBucketUsed]}`, pending: false, failed: false };
    }
    return { points, bucket, fallback: null, pending, failed };
  }

  async function refresh() {
    setLoading(true);
    try {
      await onRefresh();
      setVersion((v) => v + 1);
    } catch {
      setError("Uppdateringen misslyckades. Försök igen.");
      setLoading(false);
    }
  }

  const total = overview?.metrics.reduce((n, m) => n + m.count, 0) ?? 0;
  const first = overview?.metrics.map((m) => m.first_at).sort()[0];
  const byKind = useMemo(() => new Map(overview?.metrics.map((m) => [m.kind, m]) ?? []), [overview]);
  const known = new Set(categories.flatMap((c) => c.kinds));
  const groups = useMemo(() => {
    const result = categories
      .map((c) => ({ title: c.title, metrics: c.kinds.flatMap((k) => (byKind.has(k) ? [byKind.get(k)!] : [])) }))
      .filter((g) => g.metrics.length);
    const rest = [...byKind.values()].filter((m) => !known.has(m.kind));
    if (rest.length) result.push({ title: "Övrigt", metrics: rest });
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byKind]);
  const selectedMetric = selected ? byKind.get(selected) : undefined;

  return (
    <section className="panel vt">
      <header className="vt-head">
        <div>
          <h2>Vitalparametrar</h2>
          <p>
            {overview
              ? `${total.toLocaleString("sv-SE")} delade mätningar${first ? " sedan " + new Date(first).toLocaleDateString("sv-SE", { year: "numeric", month: "short" }) : ""}`
              : "Hämtar…"}
            {overview?.sync && (
              <span className={"vt-sync " + (overview.sync.state === "complete" ? "ok" : "warn")}>
                {overview.sync.state === "complete" ? "Synkad" : overview.sync.state === "retrying" ? "Synkningen försöker igen" : "Synkroniserar"} · {ago(overview.sync.updated_at)}
              </span>
            )}
          </p>
        </div>
        <div className="vt-tools">
          <div className="vt-range" role="group" aria-label="Period">
            {ranges.map((r) => (
              <button key={r.value} className={r.value === range ? "active" : ""} aria-pressed={r.value === range} onClick={() => setRange(r.value)}>
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" className="button secondary" disabled={loading} onClick={refresh}>
            <RefreshCw size={15} className={loading ? "vt-spin" : ""} /> Uppdatera
          </button>
        </div>
      </header>
      <LoadBar loading={loading} done={done} total={2} />
      {error && <p className="alert error" role="alert">{error}</p>}
      {(overviewError || trendError) && !loading && (
        <div className="alert error vt-retry" role="alert">
          <span>{overviewError ? `${overviewError}${overview ? " Visar senast hämtade värden." : ""}` : trendError}</span>
          <button type="button" className="button secondary" onClick={() => setVersion((v) => v + 1)}>Försök igen</button>
        </div>
      )}
      {overview && !selectedMetric && (
        <>
          {groups.map((g) => (
            <div key={g.title} className="vt-group">
              <h3>{g.title}</h3>
              <div className="vt-grid">
                {g.metrics.map((m) => (
                  <MetricTile key={m.kind} metric={m} view={resolve(m.kind)} daily={seriesFor(trend?.series ?? [], m.kind)}
                    night={m.kind === "sleep" ? overview.sleep_night : null} onOpen={() => setSelected(m.kind)} />
                ))}
              </div>
            </div>
          ))}
          {!groups.length && <p className="vt-empty">Inga mätvärden har delats från appen ännu.</p>}
          {!!overview.display_values?.length && (
            <div className="vt-group">
              <h3>Från appen</h3>
              <div className="vt-app">
                {overview.display_values.map((value) => (
                  <AppValueCard key={detail.patient.id + "-" + value.key + "-" + version} value={value} patientId={detail.patient.id}
                    count={overview.display_series?.find((s) => s.key === value.key)?.count ?? 1} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {overview && selectedMetric && (
        <MetricDetail
          key={detail.patient.id + selectedMetric.kind + version}
          patientId={detail.patient.id}
          metric={selectedMetric}
          all={[...byKind.values()]}
          view={resolve(selectedMetric.kind)}
          daily={seriesFor(trend?.series ?? [], selectedMetric.kind)}
          range={range}
          demo={demo}
          initial={detail.vitals.filter((v) => v.kind === selectedMetric.kind)}
          night={selectedMetric.kind === "sleep" ? overview.sleep_night : null}
          onBack={() => setSelected(null)}
          onSelect={setSelected}
        />
      )}
      <p className="vt-foot">
        Råmätningar bevaras med tid, enhet, källa och definition. Ingen AI-analys eller överföring till en AI-tjänst sker här. Garmin-värden som saknas i Apple Hälsa kräver en separat anslutning.
      </p>
    </section>
  );
}

function Spark({ points, bars, failed, pending, bucket = "day" }: { points: DayPoint[]; bars: boolean; failed?: boolean; pending?: boolean; bucket?: Bucket }) {
  if (pending) return <div className="vt-spark vt-spark-empty">Hämtar trend…</div>;
  if (failed) return <div className="vt-spark vt-spark-empty">Trenden kunde inte hämtas</div>;
  const w = 200;
  const h = 44;
  if (points.length < 2) return <div className="vt-spark vt-spark-empty">{points.length ? `En ${bucketWord[bucket]} med data` : "Ingen trend i perioden"}</div>;
  const values = points.map((p) => p.value);
  const min = bars ? 0 : Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 3 - ((v - min) / span) * (h - 8);
  if (bars) {
    const bw = Math.max(2, (w / points.length) * 0.7);
    return (
      <svg className="vt-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        {points.map((p, i) => (
          <rect key={p.day} x={x(i) - bw / 2} y={y(p.value)} width={bw} height={h - 3 - y(p.value)} rx="1.5" fill="#bb3278" opacity={i === points.length - 1 ? 1 : 0.55} />
        ))}
      </svg>
    );
  }
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg className="vt-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L${x(points.length - 1)} ${h} L${x(0)} ${h} Z`} fill="#bb327814" />
      <path d={line} fill="none" stroke="#bb3278" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(points.length - 1)} cy={y(values[values.length - 1])} r="3" fill="#bb3278" />
    </svg>
  );
}

function Delta({ points }: { points: DayPoint[] }) {
  const d = trendDelta(points);
  if (!d || d.pct === null) return null;
  const flat = Math.abs(d.pct) < 1;
  return (
    <span className="vt-delta" title="Snitt senaste 7 dagarna jämfört med 7 dagarna före">
      {flat ? <Minus size={12} /> : d.pct > 0 ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      {flat ? "Stabil" : `${Math.abs(Math.round(d.pct))} %`}
    </span>
  );
}

function MetricTile({ metric, view, daily, night, onOpen }: { metric: VitalSummary; view: Resolved; daily: DayPoint[]; night: VitalsOverview["sleep_night"]; onOpen: () => void }) {
  const bars = sumKinds.has(metric.kind);
  return (
    <button type="button" className={"vt-tile" + (view.fallback ? " is-history" : "")} onClick={onOpen} aria-label={`${metricTitle(metric)}, öppna trend`}>
      <div className="vt-tile-top">
        <span>{metricTitle(metric)}</span>
        <Delta points={daily} />
      </div>
      <strong>{night ? duration(night.seconds) : formatVital(metric.latest)}</strong>
      <Spark points={view.points} bars={bars} failed={view.failed} pending={view.pending} bucket={view.bucket} />
      {view.fallback && <span className="vt-history">Inget i perioden · visar {view.fallback}</span>}
      <small>
        {night ? `Natt till ${night.day}` : ago(metric.latest.end_at)} · {metric.count.toLocaleString("sv-SE")} mätningar
      </small>
    </button>
  );
}

function TrendChart({ points, kind, unit, bucket }: { points: DayPoint[]; kind: string; unit: string; bucket: Bucket }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 900;
  const h = 280;
  const pad = { l: 54, r: 16, t: 14, b: 28 };
  if (!points.length) return <div className="vt-chart vt-chart-empty">Inga mätvärden i vald period.</div>;
  const bars = sumKinds.has(kind) || intervalKinds.has(kind);
  const showBand = !bars && points.some((p) => p.n > 1 && p.max !== p.min);
  const lows = points.map((p) => (showBand ? p.min : p.value));
  const highs = points.map((p) => (showBand ? p.max : p.value));
  let lo = bars ? 0 : Math.min(...lows);
  let hi = Math.max(...highs);
  if (hi === lo) {
    hi += 1;
    lo -= bars ? 0 : 1;
  }
  const padding = bars ? 0 : (hi - lo) * 0.12;
  lo -= padding;
  hi += padding * 0.6;
  const x = (i: number) => pad.l + (points.length === 1 ? (w - pad.l - pad.r) / 2 : (i / (points.length - 1)) * (w - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((t) => lo + (hi - lo) * t);
  const label = (v: number) => (intervalKinds.has(kind) ? `${Math.round(v / 3600)} tim` : number(v));
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const band = showBand
    ? points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.max).toFixed(1)}`).join(" ") +
      " " + [...points].reverse().map((p, i) => `L${x(points.length - 1 - i).toFixed(1)} ${y(p.min).toFixed(1)}`).join(" ") + " Z"
    : "";
  const bw = Math.max(3, ((w - pad.l - pad.r) / points.length) * 0.66);
  const active = hover === null ? null : points[hover];
  return (
    <div className="vt-chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Trenddiagram"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * w;
          const idx = Math.round(((px - pad.l) / (w - pad.l - pad.r)) * (points.length - 1));
          setHover(Math.min(points.length - 1, Math.max(0, points.length === 1 ? 0 : idx)));
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="#eee9f1" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="12" fill="#787180">{label(t)}</text>
          </g>
        ))}
        {bars ? (
          points.map((p, i) => <rect key={p.day} x={x(i) - bw / 2} y={y(p.value)} width={bw} height={Math.max(1, y(lo) - y(p.value))} rx="2" fill="#bb3278" opacity={hover === i ? 1 : 0.7} />)
        ) : (
          <>
            {band && <path d={band} fill="#bb327818" />}
            <path d={line} fill="none" stroke="#bb3278" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            {points.length <= 45 && points.map((p, i) => <circle key={p.day} cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 3} fill="#bb3278" />)}
          </>
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={h - pad.b} stroke="#71375755" strokeDasharray="4 4" />}
        <text x={pad.l} y={h - 6} fontSize="12" fill="#787180">{bucketLabel(points[0].day, bucket)}</text>
        <text x={w - pad.r} y={h - 6} textAnchor="end" fontSize="12" fill="#787180">{bucketLabel(points[points.length - 1].day, bucket)}</text>
      </svg>
      {active && hover !== null && (
        <div className="vt-tip" style={{ left: `${(x(hover) / w) * 100}%` }}>
          <b>{bucket === "week" ? `Vecka ${isoWeek(active.day).week}, ${isoWeek(active.day).year}` : bucketLabel(active.day, bucket)}</b>
          <span>{valueText(kind, active.value, unit)}{bucket !== "day" && bars ? (intervalKinds.has(kind) ? " per natt" : " per dag") : ""}</span>
          {showBand && <small>{number(active.min)}–{number(active.max)} · {active.n} mätningar</small>}
          {bucket !== "day" && <small>{active.days} {active.days === 1 ? "dag" : "dagar"} med data</small>}
        </div>
      )}
    </div>
  );
}

function MetricDetail({ patientId, metric, all, view, daily, range, demo, initial, night, onBack, onSelect }: {
  patientId: string; metric: VitalSummary; all: VitalSummary[]; view: Resolved; daily: DayPoint[]; range: Range; demo: boolean; initial: Vital[];
  night: VitalsOverview["sleep_night"]; onBack: () => void; onSelect: (kind: string) => void;
}) {
  const inRange = view.points;
  const stats = summarize(inRange);
  const unit = unitFor(metric.kind, metric.latest.unit);
  const delta = trendDelta(daily);
  const ofBucket = view.bucket === "week" ? "veckans" : "månadens";
  const kind = metric.kind;
  const sumLike = sumKinds.has(kind) || intervalKinds.has(kind);
  return (
    <div className="vt-detail">
      <div className="vt-detail-top">
        <button className="button secondary" onClick={onBack}><ArrowLeft size={15} /> Alla mätvärden</button>
        <div className="vt-chips" role="tablist" aria-label="Byt mätvärde">
          {all.map((m) => (
            <button key={m.kind} role="tab" aria-selected={m.kind === kind} className={m.kind === kind ? "active" : ""} onClick={() => onSelect(m.kind)}>
              {metricTitle(m)}
            </button>
          ))}
        </div>
      </div>
      <h3 className="vt-title">{metricTitle(metric)}</h3>
      <div className="vt-stats">
        <div><span>Senaste</span><strong>{night ? duration(night.seconds) : formatVital(metric.latest)}</strong><small>{ago(metric.latest.end_at)}</small></div>
        <div><span>{sumLike ? (intervalKinds.has(kind) ? "Snitt per natt" : "Snitt per dag") : "Snitt"} · {view.fallback ?? rangeText(range)}</span><strong>{stats ? valueText(kind, stats.avg, unit) : "—"}</strong><small>{stats ? `${stats.days} dagar med data` : "Ingen data"}</small></div>
        <div><span>Lägsta</span><strong>{stats ? valueText(kind, stats.min, unit) : "—"}</strong></div>
        <div><span>Högsta</span><strong>{stats ? valueText(kind, stats.max, unit) : "—"}</strong></div>
        <div><span>Förändring</span><strong>{delta?.pct === null || !delta ? "—" : `${delta.pct > 0 ? "+" : ""}${Math.round(delta.pct)} %`}</strong><small>7 dagar mot 7 före</small></div>
      </div>
      {view.pending ? <div className="vt-chart vt-chart-empty">Hämtar trend…</div>
        : view.failed ? <div className="vt-chart vt-chart-empty">Trenden kunde inte hämtas. Försök igen med Uppdatera.</div>
        : <TrendChart points={inRange} kind={kind} unit={unit} bucket={view.bucket} />}
      <p className="vt-note">
        {view.fallback && `Inga mätningar i vald period, visar hela historiken per ${bucketWord[view.bucket]}. `}
        {view.bucket === "day"
          ? (sumLike ? "Varje stapel är ett dygn." : "Linjen visar dygnets medelvärde och det skuggade fältet lägsta till högsta.")
          : (sumLike ? `Varje stapel är ${ofBucket} snitt per ${intervalKinds.has(kind) ? "natt" : "dygn"}.` : `Linjen visar ${ofBucket} medelvärde och det skuggade fältet lägsta till högsta.`)}
        {" "}Dygn räknas i svensk tid.
      </p>
      <RawHistory key={kind} patientId={patientId} metric={metric} demo={demo} initial={initial} />
    </div>
  );
}

function RawHistory({ patientId, metric, demo, initial }: { patientId: string; metric: VitalSummary; demo: boolean; initial: Vital[] }) {
  const [samples, setSamples] = useState<Vital[]>([]);
  const [next, setNext] = useState<HistoryCursor | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [before, setBefore] = useState("");
  async function load(cursor: HistoryCursor | null = next, reset = false) {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const page: VitalsPage = demo ? { samples: initial, next: null } : await request({ action: "vitals_page", patientId, kind: metric.kind, cursor: reset ? cursor : loaded ? cursor : null });
      setSamples((previous) => (reset ? page.samples : mergeSamples(previous, page.samples)));
      setNext(page.next);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Historiken kunde inte hämtas.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <details className="vital-history vt-raw" onToggle={(event) => { if (event.currentTarget.open && !loaded && !loading) void load(); }}>
      <summary>Råmätningar och hela historiken ({metric.count.toLocaleString("sv-SE")})</summary>
      {!demo && (
        <form className="history-date-search" onSubmit={(event) => { event.preventDefault(); if (before) void load({ at: before + "T23:59:59.999999Z", id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }, true); }}>
          <label>Visa mätningar före datum (UTC)<input aria-label="Historikdatum" type="date" value={before} onChange={(event) => setBefore(event.target.value)} /></label>
          <button type="submit" className="button secondary" disabled={loading || !before}>Visa historik</button>
          <button type="button" className="text-button" disabled={loading} onClick={() => { setBefore(""); void load(null, true); }}>Visa senaste</button>
        </form>
      )}
      <p className="muted">Visar {samples.length} inlästa råmätningar av totalt {metric.count}. Tider visas i webbläsarens tidszon. Samtidiga källor visas separat och summeras inte.</p>
      <div className="table-scroll"><table><thead><tr><th>Från – till</th><th>Värde</th><th>Källa och definition</th></tr></thead><tbody>
        {samples.map((v) => <tr key={v.id}><td>{time(v.start_at)}<br />{time(v.end_at)}</td><td>{formatVital(v)}</td><td>{v.source}<br /><small>{v.definition}{v.metadata?.user_entered === true ? " · Manuellt inmatat" : ""}</small></td></tr>)}
      </tbody></table></div>
      {loading && <p role="status">Hämtar…</p>}
      {((loaded && next) || (!loaded && error)) && <button type="button" className="button secondary" disabled={loading} onClick={() => void load()}>{loaded ? "Hämta äldre mätningar" : "Försök igen"}</button>}
      {error && <p className="alert error" role="alert">{error}</p>}
    </details>
  );
}

function AppValueCard({ value, patientId, count }: { value: AppDisplayValue; patientId: string; count: number }) {
  const [items, setItems] = useState<AppDisplayValue[]>([]);
  const [cursor, setCursor] = useState<HistoryCursor | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const result: { samples: AppDisplayValue[]; next: HistoryCursor | null } = await request({ action: "app_value_history", patientId, kind: value.key, cursor: loaded ? cursor : null });
      setItems((old) => [...new Map([...old, ...result.samples].map((v) => [v.event_id, v])).values()]);
      setCursor(result.next);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Historiken kunde inte hämtas.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <article className="vt-appcard">
      <span>{value.title}</span>
      <strong>{value.value} <small>{value.unit}</small></strong>
      <small>{value.section} · avläst {ago(value.observed_at)}</small>
      <details onToggle={(e) => { if (e.currentTarget.open && !loaded && !loading) void load(); }}>
        <summary>Historik ({count})</summary>
        <div className="table-scroll"><table><thead><tr><th>Mättid / avläsning</th><th>Värde</th><th>Källa</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.event_id}><td>{item.measured_at ? time(item.measured_at) : "Avläst " + time(item.observed_at)}</td><td>{item.value} {item.unit}</td><td>{item.source}</td></tr>)}
        </tbody></table></div>
        {loading && <p role="status">Hämtar…</p>}
        {((loaded && cursor) || (!loaded && error)) && <button className="button secondary" disabled={loading} onClick={load}>{loaded ? "Hämta äldre värden" : "Försök igen"}</button>}
        {error && <p role="alert">{error}</p>}
      </details>
    </article>
  );
}

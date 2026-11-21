import type { Vital } from "./model";

export type TrendRow = {
  kind: string;
  day: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  sum: number | null;
  n: number | null;
};
export type TrendResponse = { days: number; series: TrendRow[] };
export type DayPoint = { day: string; value: number; min: number; max: number; n: number };

/** Metrics that add up over a day. Everything else is shown as the daily average. */
export const sumKinds = new Set(["steps", "step-count", "distance", "active-energy", "flights", "workout"]);
/** Metrics stored as time intervals. Their daily value is a duration in seconds. */
export const intervalKinds = new Set(["sleep", "sleep-awake", "sleep-in-bed"]);

export const categories: { title: string; kinds: string[] }[] = [
  { title: "Hjärta och kondition", kinds: ["resting-heart-rate", "heart-rate", "hrv", "hrv-rmssd", "oxygen", "vo2-max"] },
  { title: "Aktivitet", kinds: ["steps", "step-count", "distance", "active-energy", "flights", "workout"] },
  { title: "Sömn", kinds: ["sleep", "sleep-in-bed", "sleep-awake"] },
  { title: "Kropp och andning", kinds: ["weight", "temperature", "respiratory-rate", "fev1", "fvc", "pef"] },
];

export function seriesFor(rows: TrendRow[], kind: string): DayPoint[] {
  const useSum = sumKinds.has(kind) || intervalKinds.has(kind);
  return rows
    .filter((r) => r.kind === kind)
    .flatMap((r) => {
      const value = useSum ? r.sum : r.avg;
      if (value === null || !Number.isFinite(value)) return [];
      return [{ day: r.day, value, min: r.min ?? value, max: r.max ?? value, n: r.n ?? 1 }];
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

const dayNumber = (day: string) => Math.floor(Date.parse(day + "T00:00:00Z") / 86400000);

/** Points from the last `days` calendar days, counted back from the newest point. */
export function lastDays(points: DayPoint[], days: number): DayPoint[] {
  if (!points.length) return [];
  const newest = dayNumber(points[points.length - 1].day);
  return points.filter((p) => newest - dayNumber(p.day) < days);
}

const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;

/** Average of the newest 7 days compared with the 7 days before. Null when either side has no data. */
export function trendDelta(points: DayPoint[]): { current: number; previous: number; pct: number | null } | null {
  if (!points.length) return null;
  const newest = dayNumber(points[points.length - 1].day);
  const current = points.filter((p) => newest - dayNumber(p.day) < 7).map((p) => p.value);
  const previous = points.filter((p) => newest - dayNumber(p.day) >= 7 && newest - dayNumber(p.day) < 14).map((p) => p.value);
  if (!current.length || !previous.length) return null;
  const c = mean(current);
  const p = mean(previous);
  return { current: c, previous: p, pct: p === 0 ? null : ((c - p) / Math.abs(p)) * 100 };
}

export function summarize(points: DayPoint[]) {
  if (!points.length) return null;
  const values = points.map((p) => p.value);
  return {
    latest: points[points.length - 1],
    avg: mean(values),
    min: Math.min(...points.map((p) => p.min)),
    max: Math.max(...points.map((p) => p.max)),
    days: points.length,
  };
}

/** Builds trend rows from loaded samples, used by the demonstration environment. */
export function rowsFromVitals(vitals: Vital[]): TrendRow[] {
  const groups = new Map<string, number[]>();
  for (const v of vitals) {
    if (v.value === null) continue;
    const key = v.kind + "|" + (v.calendar_day ?? v.end_at.slice(0, 10));
    groups.set(key, [...(groups.get(key) ?? []), v.value]);
  }
  return [...groups.entries()].map(([key, values]) => {
    const [kind, day] = key.split("|");
    return { kind, day, avg: mean(values), min: Math.min(...values), max: Math.max(...values), sum: values.reduce((s, v) => s + v, 0), n: values.length };
  });
}

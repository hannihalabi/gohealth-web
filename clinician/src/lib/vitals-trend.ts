import type { Vital } from "./model";

export type TrendRow = {
  kind: string;
  day: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  sum: number | null;
  n: number | null;
  /** Days with data in the bucket (1 for daily rows). */
  days?: number | null;
};
/** Server grouping. Week and month rows carry the sample-weighted mean (avg) and the mean daily total (sum). */
export type Bucket = "day" | "week" | "month";
export type TrendResponse = { days: number; bucket?: Bucket; series: TrendRow[] };
export type DayPoint = { day: string; value: number; min: number; max: number; n: number; days: number };

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
      // Totals compare with totals: the lowest day is the smallest daily total, not the smallest single sample.
      const min = useSum ? value : r.min ?? value;
      const max = useSum ? value : r.max ?? value;
      return [{ day: r.day, value, min, max, n: r.n ?? 1, days: r.days ?? 1 }];
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

/**
 * Average of the newest 7 days compared with the 7 days before.
 * Null unless the data is recent (newest point within 7 days of today) and each week has at least 3 days,
 * so a single sparse day cannot produce a misleading percentage.
 */
export function trendDelta(points: DayPoint[], now = Date.now()): { current: number; previous: number; pct: number | null } | null {
  if (!points.length) return null;
  const newest = dayNumber(points[points.length - 1].day);
  if (Math.floor(now / 86400000) - newest > 7) return null;
  const current = points.filter((p) => newest - dayNumber(p.day) < 7).map((p) => p.value);
  const previous = points.filter((p) => newest - dayNumber(p.day) >= 7 && newest - dayNumber(p.day) < 14).map((p) => p.value);
  if (current.length < 3 || previous.length < 3) return null;
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
    days: points.reduce((n, p) => n + p.days, 0),
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

/** First day of the week (Monday) or month that contains `day`. */
export function bucketStart(day: string, bucket: Bucket): string {
  if (bucket === "month") return day.slice(0, 8) + "01";
  if (bucket === "day") return day;
  const n = dayNumber(day);
  const weekday = (new Date(n * 86400000).getUTCDay() + 6) % 7;
  return new Date((n - weekday) * 86400000).toISOString().slice(0, 10);
}

/** ISO week number and week-year for a date. */
export function isoWeek(day: string): { week: number; year: number } {
  const n = dayNumber(day);
  const thursday = n - ((new Date(n * 86400000).getUTCDay() + 6) % 7) + 3;
  const year = new Date(thursday * 86400000).getUTCFullYear();
  return { week: 1 + Math.floor((thursday - dayNumber(`${year}-01-01`)) / 7), year };
}

/** Groups daily rows into weeks or months with the same rules as the server. Used by the demonstration environment. */
export function bucketRows(rows: TrendRow[], bucket: Bucket): TrendRow[] {
  if (bucket === "day") return rows;
  const groups = new Map<string, TrendRow[]>();
  for (const r of rows) {
    const key = `${r.kind}|${r.avg === null ? "i" : "v"}|${bucketStart(r.day, bucket)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const [kind, type, day] = key.split("|");
    const totals = list.map((r) => r.sum ?? 0);
    if (type === "i") return { kind, day, avg: null, min: null, max: null, sum: mean(totals), n: null, days: list.length };
    const n = list.reduce((s, r) => s + (r.n ?? 1), 0);
    return {
      kind, day, n, days: list.length,
      avg: totals.reduce((s, v) => s + v, 0) / n,
      min: Math.min(...list.map((r) => r.min ?? Infinity)),
      max: Math.max(...list.map((r) => r.max ?? -Infinity)),
      sum: mean(totals),
    };
  });
}

/** "Allt" picks a resolution that fits the length of the history. */
export function allBucket(days: number): Bucket {
  return days <= 90 ? "day" : days <= 1100 ? "week" : "month";
}

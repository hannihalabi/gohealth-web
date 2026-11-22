import assert from "node:assert/strict";
import test from "node:test";
import { allBucket, bucketRows, bucketStart, isoWeek, lastDays, rowsFromVitals, seriesFor, summarize, trendDelta, type TrendRow } from "../src/lib/vitals-trend";

const row = (kind: string, day: string, avg: number, sum = avg, n = 1): TrendRow => ({ kind, day, avg, min: avg - 1, max: avg + 1, sum, n });

test("daily series use the sum for accumulating metrics and the average otherwise", () => {
  const rows = [row("steps", "2026-11-20", 5000, 5000), row("resting-heart-rate", "2026-11-20", 60, 120, 2)];
  assert.equal(seriesFor(rows, "steps")[0].value, 5000);
  assert.equal(seriesFor(rows, "resting-heart-rate")[0].value, 60);
  assert.deepEqual(seriesFor([{ kind: "sleep", day: "2026-11-20", avg: null, min: null, max: null, sum: 25200, n: null }], "sleep")[0].value, 25200);
});
test("the delta compares the newest 7 days with the 7 before", () => {
  const rows: TrendRow[] = [];
  for (let d = 1; d <= 14; d++) rows.push(row("resting-heart-rate", `2026-11-${String(d).padStart(2, "0")}`, d <= 7 ? 60 : 66));
  const now = Date.parse("2026-11-15T12:00:00Z");
  const delta = trendDelta(seriesFor(rows, "resting-heart-rate"), now)!;
  assert.equal(delta.current, 66);
  assert.equal(delta.previous, 60);
  assert.equal(Math.round(delta.pct!), 10);
  assert.equal(trendDelta(seriesFor(rows.slice(7), "resting-heart-rate"), now), null);
});
test("ranges count back from the newest day and summaries cover the range", () => {
  const rows = [row("weight", "2026-10-01", 80), row("weight", "2026-11-18", 82), row("weight", "2026-11-20", 84)];
  const points = seriesFor(rows, "weight");
  assert.equal(lastDays(points, 7).length, 2);
  assert.equal(lastDays(points, 90).length, 3);
  const s = summarize(lastDays(points, 7))!;
  assert.equal(s.avg, 83);
  assert.equal(s.latest.value, 84);
  assert.equal(summarize([]), null);
});
test("demonstration rows are built from loaded samples", () => {
  const rows = rowsFromVitals([
    { id: "1", kind: "steps", value: 100, unit: "count", start_at: "2026-11-20T00:00:00Z", end_at: "2026-11-20T10:00:00Z", source: "s", definition: "d", deleted_at: null, calendar_day: "2026-11-20" },
    { id: "2", kind: "steps", value: 50, unit: "count", start_at: "2026-11-20T11:00:00Z", end_at: "2026-11-20T12:00:00Z", source: "s", definition: "d", deleted_at: null, calendar_day: "2026-11-20" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sum, 150);
  assert.equal(rows[0].n, 2);
});

test("the delta needs recent data and at least 3 days in each week", () => {
  const sparse = [row("workout", "2026-11-03", 0.3), row("workout", "2026-11-12", 30), row("workout", "2026-11-13", 33), row("workout", "2026-11-14", 36)];
  assert.equal(trendDelta(seriesFor(sparse, "workout"), Date.parse("2026-11-15T12:00:00Z")), null, "one sparse day must not give 9875 %");
  const rows: TrendRow[] = [];
  for (let d = 1; d <= 14; d++) rows.push(row("resting-heart-rate", `2026-11-${String(d).padStart(2, "0")}`, 60));
  assert.equal(trendDelta(seriesFor(rows, "resting-heart-rate"), Date.parse("2026-12-30T12:00:00Z")), null, "old data has no current change");
});
test("totals use daily totals for lowest and highest", () => {
  const p = seriesFor([{ kind: "steps", day: "2026-11-20", avg: 50, min: 3, max: 900, sum: 5000, n: 100 }], "steps")[0];
  assert.equal(p.min, 5000);
  assert.equal(p.max, 5000);
});
test("weeks start on Monday, months on the first, and ISO weeks follow the Thursday rule", () => {
  assert.equal(bucketStart("2026-11-22", "week"), "2026-11-16");
  assert.equal(bucketStart("2026-11-16", "week"), "2026-11-16");
  assert.equal(bucketStart("2026-11-22", "month"), "2026-11-01");
  assert.deepEqual(isoWeek("2026-11-16"), { week: 47, year: 2026 });
  assert.deepEqual(isoWeek("2021-01-03"), { week: 53, year: 2020 });
  assert.deepEqual(isoWeek("2024-12-30"), { week: 1, year: 2025 });
});
test("week and month buckets keep the weighted mean, the mean daily total and the day count", () => {
  const rows: TrendRow[] = [
    { kind: "heart-rate", day: "2026-11-16", avg: 60, min: 50, max: 70, sum: 120, n: 2 },
    { kind: "heart-rate", day: "2026-11-17", avg: 90, min: 90, max: 90, sum: 90, n: 1 },
    { kind: "sleep", day: "2026-11-16", avg: null, min: null, max: null, sum: 7 * 3600, n: null },
    { kind: "sleep", day: "2026-11-18", avg: null, min: null, max: null, sum: 9 * 3600, n: null },
  ];
  const week = bucketRows(rows, "week");
  const hr = week.find((r) => r.kind === "heart-rate")!;
  assert.equal(hr.avg, 70);
  assert.equal(hr.sum, 105);
  assert.equal(hr.min, 50);
  assert.equal(hr.max, 90);
  assert.equal(hr.n, 3);
  assert.equal(hr.days, 2);
  const sleep = week.find((r) => r.kind === "sleep")!;
  assert.equal(sleep.sum, 8 * 3600);
  assert.equal(seriesFor(week, "sleep")[0].days, 2);
  assert.equal(summarize(seriesFor(week, "heart-rate"))!.days, 2);
});
test("all history uses days, weeks or months depending on its length", () => {
  assert.equal(allBucket(40), "day");
  assert.equal(allBucket(400), "week");
  assert.equal(allBucket(4000), "month");
});

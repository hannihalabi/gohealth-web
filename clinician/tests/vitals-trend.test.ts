import assert from "node:assert/strict";
import test from "node:test";
import { lastDays, rowsFromVitals, seriesFor, summarize, trendDelta, type TrendRow } from "../src/lib/vitals-trend";

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
  const delta = trendDelta(seriesFor(rows, "resting-heart-rate"))!;
  assert.equal(delta.current, 66);
  assert.equal(delta.previous, 60);
  assert.equal(Math.round(delta.pct!), 10);
  assert.equal(trendDelta(seriesFor(rows.slice(7), "resting-heart-rate")), null);
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

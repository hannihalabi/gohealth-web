import assert from "node:assert/strict";
import test from "node:test";
import { addDays, dayLabel, slotCount, timeRange, weekDays, weekStart } from "../src/lib/booking";

test("weeks start on Monday and cross months", () => {
  assert.equal(weekStart("2026-11-26"), "2026-11-23");
  assert.equal(weekStart("2026-11-23"), "2026-11-23");
  assert.equal(weekStart("2026-11-29"), "2026-11-23");
  assert.deepEqual(weekDays("2026-11-30").slice(0, 2), ["2026-11-30", "2026-12-01"]);
  assert.equal(addDays("2026-03-28", 2), "2026-03-30");
});

test("Swedish day labels and time ranges in Stockholm time", () => {
  assert.equal(dayLabel("2026-11-24"), "tis 24 nov");
  assert.equal(timeRange("2026-11-25T08:20:00Z", "2026-11-25T08:40:00Z"), "ons 25 nov 09:20–09:40");
  assert.equal(timeRange("2026-07-01T07:00:00Z", null), "ons 1 jul 09:00");
});

test("a block gives whole times only", () => {
  assert.equal(slotCount("09:00", "12:00", 20), 9);
  assert.equal(slotCount("09:00", "09:50", 20), 2);
  assert.equal(slotCount("10:00", "09:00", 20), 0);
  assert.equal(slotCount("9", "10:00", 20), 0);
});

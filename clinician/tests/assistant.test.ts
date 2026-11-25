import assert from "node:assert/strict";
import test from "node:test";
import { buildBriefing, followupsDue, greetingFor } from "../src/lib/assistant";
import type { HomeData } from "../src/lib/clinician-home";

const now = new Date("2026-11-25T08:00:00Z"); // 09:00 in Stockholm
const empty: HomeData = { counts: { assigned: 2, clinic: 4, unsigned: 0, consultations: 0, messages: 0 }, unsigned: [], announcements: [], consultations: [], deviations: [] };

test("greeting follows the Stockholm clock", () => {
  assert.equal(greetingFor(now), "God morgon");
  assert.equal(greetingFor(new Date("2026-11-25T12:00:00Z")), "God eftermiddag");
});

test("a quiet day says so and is calm", () => {
  const b = buildBriefing(empty, "Hanni Halabi (Läkare)", now);
  assert.equal(b.greeting, "God morgon, Hanni");
  assert.equal(b.mood, "calm");
  assert.match(b.lines[0], /Allt är lugnt/);
  assert.equal(b.focus.length, 0);
});

test("meetings, urgent values, reviews and drafts become lines and focus chips", () => {
  const data: HomeData = {
    ...empty,
    counts: { ...empty.counts, unsigned: 1, messages: 1 },
    unsigned: [{ id: "u", patient_id: "p1", display_name: "Alex", kind: "lab", title: "TSH", created_at: "2026-11-24T08:00:00Z" }],
    agenda: [{ id: "m", patient_id: "p1", display_name: "Alex", visit_type: "video", starts_at: "2026-11-25T09:20:00Z", ends_at: "2026-11-25T09:40:00Z" }],
    deviations: [
      { patient_id: "p1", display_name: "Alex", rule: "oxygen", category: "vitals", severity: "high", title: "Låg syremättnad", detail: "", at: null },
      { patient_id: "p2", display_name: "Kim", rule: "lab", category: "lab", severity: "warn", title: "Provsvar utanför referens", detail: "", at: null },
      { patient_id: "p2", display_name: "Kim", rule: "lab", category: "lab", severity: "warn", title: "Provsvar utanför referens", detail: "", at: null, reviewed_at: "2026-11-24T10:00:00Z" },
    ],
  };
  const b = buildBriefing(data, "Hanni Halabi", now);
  assert.equal(b.mood, "alert");
  assert.match(b.lines[0], /^Du har 1 möte idag: 10:20 Alex \(videosamtal\)\.$/);
  assert.ok(b.lines.some((l) => l.includes("Alex (låg syremättnad)")));
  assert.ok(b.lines.some((l) => l.startsWith("1 provsvar utanför referens och 1 avvikande trend väntar")));
  assert.deepEqual(b.focus.map((f) => [f.target, f.count]), [["agenda", 1], ["review", 2], ["drafts", 1], ["messages", 1]]);
});

test("follow-ups due within a week or never held, unless booked", () => {
  const due = followupsDue([
    { patient_id: "a", display_name: "A", last_at: null, next_at: null, next_visit_type: null, due_on: null },
    { patient_id: "b", display_name: "B", last_at: "x", next_at: null, next_visit_type: null, due_on: "2026-11-20" },
    { patient_id: "c", display_name: "C", last_at: "x", next_at: null, next_visit_type: null, due_on: "2026-11-30" },
    { patient_id: "d", display_name: "D", last_at: "x", next_at: null, next_visit_type: null, due_on: "2026-12-20" },
    { patient_id: "e", display_name: "E", last_at: "x", next_at: "2026-12-01T08:00:00Z", next_visit_type: "phone", due_on: "2026-11-20" },
  ], now);
  assert.deepEqual(due.map((f) => [f.patient_id, f.overdue]), [["a", true], ["b", true], ["c", false]]);
});

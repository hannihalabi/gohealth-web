import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClinicalDateError,
  parseLocalDateTime,
  displayStatus,
  isSameOrigin,
  labSchema,
  normalizeSearch,
  validatePayload,
} from "../src/lib/model";
test("sampling timestamps reject overflow dates and require an explicit time", () => {
  assert.throws(() => parseLocalDateTime("2026-02-30 08:00"));
  assert.throws(() => parseLocalDateTime("2026-11-17"));
  assert.equal(
    Number.isFinite(Date.parse(parseLocalDateTime("2026-11-16 08:30"))),
    true,
  );
});
test("imaging dates beyond the database tolerance produce a field-specific error", () => {
  const now = Date.now();
  const report = {
    title: "Bildutlåtande", source: "Test", comment: "", modality: "CT",
    bodyPart: "Bröstkorg", conclusion: "Syntetiskt test", studyId: "",
  };
  assert.doesNotThrow(() => validatePayload("imaging", {
    ...report, sampledAt: new Date(now + 60 * 60 * 1000).toISOString(),
  }));
  assert.throws(() => validatePayload("imaging", {
    ...report, sampledAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
  }), (error) => error instanceof ClinicalDateError && /Undersökningstiden ligger för långt fram/.test(error.message));
});
import { demoDetail, demoPatients, demoPublish } from "../src/lib/demo";
test("reference intervals do not turn missing values into normal values", () => {
  const o = demoDetail(demoPatients[0]).records[0].payload.observations[0];
  assert.equal(
    displayStatus({ ...o, referenceLow: null, referenceHigh: null }),
    "Mätt",
  );
  assert.equal(displayStatus({ ...o, value: "5" }), "Utanför intervall");
  assert.equal(displayStatus({ ...o, comparator: "<", value: "5" }), "Mätt");
});
test("invalid numbers, reversed intervals and duplicate analytes are rejected", () => {
  const p = demoDetail(demoPatients[0]).records[0].payload;
  assert.equal(
    labSchema.safeParse({
      ...p,
      observations: [{ ...p.observations[0], value: "NaN" }],
    }).success,
    false,
  );
  assert.equal(
    labSchema.safeParse({
      ...p,
      observations: [
        { ...p.observations[0], referenceLow: 5, referenceHigh: 1 },
      ],
    }).success,
    false,
  );
  assert.equal(
    labSchema.safeParse({
      ...p,
      observations: [p.observations[0], p.observations[0]],
    }).success,
    false,
  );
});
test("CSRF origin checks compare full origins and reject absent origins", () => {
  assert.equal(isSameOrigin(null, "https://clinician.hemlakare.se"), false);
  assert.equal(
    isSameOrigin(
      "https://clinician.hemlakare.se.evil.test",
      "https://clinician.hemlakare.se",
    ),
    false,
  );
  assert.equal(
    isSameOrigin(
      "https://clinician.hemlakare.se",
      "https://clinician.hemlakare.se",
    ),
    true,
  );
  assert.equal(normalizeSearch("19900101-1234"), "199001011234");
});
test("a correction supersedes only the intended published original", () => {
  const original = demoDetail(demoPatients[0]).records[0];
  const correction = {
    ...original,
    id: "correction",
    replaces_id: original.id,
    status: "draft" as const,
    published_at: null,
    version: 2,
  };
  const result = demoPublish(
    [original, correction],
    correction.id,
    "2026-11-17T09:00:00Z",
  );
  assert.equal(result[0].superseded_at, "2026-11-17T09:00:00Z");
  assert.equal(result[1].status, "published");
  assert.throws(() =>
    demoPublish(result, correction.id, "2026-11-17T10:00:00Z"),
  );
});

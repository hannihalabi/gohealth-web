import { test } from "node:test";
import assert from "node:assert/strict";
import { demoOverview, integrationPositions, overviewRequest } from "../src/lib/overview";
import type { Member } from "../src/lib/administration";

test("overview requires clinic scope and bounded pagination; accepts no privilege hints", () => {
  const request = { action: "overview", organizationId: "30000000-0000-4000-8000-000000000001" };
  assert.equal(overviewRequest.safeParse({ action: "overview" }).success, false);
  assert.equal(overviewRequest.safeParse({ ...request, memberOffset: -1 }).success, false);
  assert.equal(overviewRequest.safeParse({ ...request, memberOffset: 100001 }).success, false);
  assert.equal(overviewRequest.safeParse({ ...request, memberPortal: "patient" }).success, false);
  assert.equal(overviewRequest.safeParse({ ...request, serviceRole: true }).success, false);
  assert.deepEqual(overviewRequest.parse(request), { ...request, memberPortal: "clinician", memberOffset: 0 });
});
test("registry layout adapts to added and removed systems", () => {
  for (const count of [0, 1, 3, 4, 5, 8]) {
    const positions = integrationPositions(count);
    assert.equal(positions.length, count);
    assert.equal(new Set(positions.map((p) => `${p.x},${p.y}`)).size, count);
    for (const p of positions) assert.ok(Number.isFinite(p.x) && p.x > 0 && p.x < 100 && p.y > 0 && p.y < 100);
  }
});
test("demo keeps roles separate and reflects deactivation with the satellite disconnected", () => {
  const base = { email: "test@example.invalid", revision: 1, display_name: "Test" };
  const members: Member[] = [
    { ...base, user_id: "1", active: true, role: "admin" },
    { ...base, user_id: "2", active: true, role: "doctor" },
    { ...base, user_id: "3", active: false, role: "nurse" },
  ];
  const value = demoOverview(members, 1, "clinician");
  assert.equal(value.memberTotal, 2);
  assert.equal(value.counts.clinician, 1);
  assert.ok(value.members.every((m) => m.role !== "admin"));
  assert.equal(value.integrations.find((i) => i.kind === "website")?.connected, false);
  assert.equal(demoOverview(members, 1, "admin").members[0].role, "admin");
});

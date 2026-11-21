import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectoryError, readOrganizationDirectory } from "../src/lib/organization-directory";
import type { Member } from "../src/lib/administration";

const organizationId = "30000000-0000-4000-8000-000000000001";
const member = (id: number, role: Member["role"] = "doctor"): Member => ({
  user_id: String(id), display_name: `Person ${id}`, email: `person-${id}@example.invalid`,
  active: true, role, revision: 1,
});
function page(portal: string, offset: number, members: Member[], total: number) {
  return { members, memberPortal: portal, memberOffset: offset, memberTotal: total,
    memberLimit: 50, counts: { pending: 2 }, checkedAt: "2026-11-21T16:00:00Z" };
}

test("directory reads every page within the requested clinic and preserves dual roles", async () => {
  const calls: { memberPortal: string; memberOffset: number }[] = [];
  const signal = new AbortController().signal;
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "/api/admin");
    assert.equal(init?.signal, signal);
    assert.equal(init?.cache, "no-store");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.organizationId, organizationId);
    assert.equal(body.action, "overview");
    calls.push(body);
    if (body.memberPortal === "admin") return Response.json(page("admin", 0, [member(1, "admin")], 1));
    const roster = Array.from({ length: 57 }, (_, i) => member(i + 1));
    return Response.json(page("clinician", body.memberOffset, roster.slice(body.memberOffset, body.memberOffset + 50), roster.length));
  };
  const result = await readOrganizationDirectory(organizationId, signal, request);
  assert.equal(result.members.length, 58);
  assert.equal(result.members.filter((m) => m.user_id === "1").length, 2);
  assert.equal(result.pending, 2);
  assert.deepEqual(calls.map((c) => `${c.memberPortal}:${c.memberOffset}`).sort(), ["admin:0", "clinician:0", "clinician:50"]);
});

test("a later page denial fails the entire directory instead of returning partial staff", async () => {
  const request: typeof fetch = async (_url, init) => {
    const { memberPortal, memberOffset } = JSON.parse(String(init?.body));
    if (memberPortal === "admin") return Response.json(page("admin", 0, [], 0));
    if (memberOffset) return Response.json({ error: "Åtkomst nekad" }, { status: 403 });
    return Response.json(page("clinician", 0, Array.from({ length: 50 }, (_, i) => member(i)), 57));
  };
  await assert.rejects(readOrganizationDirectory(organizationId, new AbortController().signal, request), (error: unknown) => error instanceof DirectoryError && error.status === 403);
});

test("a mismatched portal or repeated cursor is rejected", async () => {
  const request: typeof fetch = async () => Response.json(page("other-clinic", 0, [member(1)], 1));
  await assert.rejects(readOrganizationDirectory(organizationId, new AbortController().signal, request), /Personaluppgifterna/);
});

test("an empty middle page cannot silently omit people or loop", async () => {
  const request: typeof fetch = async (_url, init) => {
    const { memberPortal, memberOffset } = JSON.parse(String(init?.body));
    return Response.json(page(memberPortal, memberOffset, [], memberPortal === "admin" ? 0 : 80));
  };
  await assert.rejects(readOrganizationDirectory(organizationId, new AbortController().signal, request), /ändrades under hämtningen/);
});

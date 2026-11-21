import { test } from "node:test";
import assert from "node:assert/strict";
import {
  administrationCommand,
  invitationState,
  portalSessionReady,
  type Invitation,
} from "../src/lib/administration";
const organizationId = "30000000-0000-4000-8000-000000000001";
test("only password-authenticated sessions can skip MFA under the beta policy", () => {
  assert.equal(portalSessionReady({ aal: "aal2" }), true);
  assert.equal(portalSessionReady({ aal: "aal1", password_session: true }), false);
  assert.equal(portalSessionReady({ aal: "aal1", mfa_required: true, password_session: true }), false);
  assert.equal(portalSessionReady({ aal: "aal1", mfa_required: false }), false);
  assert.equal(portalSessionReady({ aal: "aal1", mfa_required: false, password_session: false }), false);
  assert.equal(portalSessionReady({ aal: "aal1", mfa_required: false, password_session: true }), true);
  assert.equal(portalSessionReady({ aal: "unknown", mfa_required: false, password_session: true }), false);
});
test("administration validates scope, explicit activation and unknown fields", () => {
  assert.equal(
    administrationCommand.safeParse({ action: "snapshot", query: "" }).success,
    false,
  );
  assert.equal(
    administrationCommand.safeParse({
      action: "invite",
      organizationId,
      name: "Test",
      email: "test@example.invalid",
      role: "owner",
      identityAttested: true,
    }).success,
    false,
  );
  assert.equal(
    administrationCommand.safeParse({
      action: "patient",
      organizationId,
      name: "Test",
      email: "test@example.invalid",
      identity: "TEST-123",
      identityAttested: false,
    }).success,
    false,
  );
  assert.equal(
    administrationCommand.safeParse({
      action: "snapshot",
      organizationId,
      query: "",
      serviceRole: "admin",
    }).success,
    false,
  );
});
test("invitation state distinguishes expired, cancelled and accepted records", () => {
  const i: Invitation = {
    id: "test",
    display_name: "Test",
    email: "test@example.invalid",
    role: "doctor",
    revision: 1,
    expires_at: "2026-11-20T00:00:00Z",
    cancelled_at: null,
    accepted_at: null,
  };
  const now = Date.parse("2026-11-17T00:00:00Z");
  assert.equal(invitationState(i, now), "Väntar på aktivering");
  assert.equal(
    invitationState(i, Date.parse("2026-11-21T00:00:00Z")),
    "Utgången",
  );
  assert.equal(
    invitationState({ ...i, cancelled_at: "2026-11-17T00:00:00Z" }, now),
    "Återkallad",
  );
  assert.equal(
    invitationState({ ...i, accepted_at: "2026-11-17T00:00:00Z" }, now),
    "Aktiverad",
  );
});

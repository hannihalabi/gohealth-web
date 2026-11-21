import { test } from "node:test";
import assert from "node:assert/strict";
import { changeOwnPassword as completeRecovery, recoveryAccount, recoveryCommand, RecoveryError, type RecoveryAuth } from "../src/lib/recovery";
const password = "Synthetic-test-password-2026";
const accountId = "10000000-0000-4000-8000-000000000001";
function changeOwnPassword(auth: RecoveryAuth, password: string, mfaCode?: string) {
  return completeRecovery(auth, { accountId, password, mfaCode });
}
function fixture(options: {
  absent?: boolean; unconfirmed?: boolean; mfa?: boolean; aal2?: boolean;
  verificationFails?: boolean; verificationDoesNotElevate?: boolean;
  levelFails?: boolean; factorsFail?: boolean; updateFails?: boolean; logoutThrows?: boolean;
} = {}) {
  const calls: string[] = [];
  let level = options.aal2 ? "aal2" : "aal1";
  const auth: RecoveryAuth = {
    async getUser() { return { data: { user: options.absent ? null : {
      id: accountId, email: "test@example.invalid", email_confirmed_at: options.unconfirmed ? undefined : "2026-11-01T00:00:00Z",
    } }, error: null }; },
    mfa: {
      async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: level, nextLevel: options.mfa ? "aal2" : level }, error: options.levelFails ? new Error("test") : null }; },
      async listFactors() { return { data: { totp: options.mfa ? [{ id: "own-factor", status: "verified" }] : [] }, error: options.factorsFail ? new Error("test") : null }; },
      async challengeAndVerify(args) {
        calls.push("verify:" + args.factorId);
        if (!options.verificationFails && !options.verificationDoesNotElevate) level = "aal2";
        return { error: options.verificationFails ? new Error("test") : null };
      },
    },
    async updateUser(args) { assert.deepEqual(args, { password }); calls.push("update-own-password"); return { error: options.updateFails ? new Error("test") : null }; },
    async signOut(args) { assert.deepEqual(args, { scope: "global" }); calls.push("sign-out-all"); if (options.logoutThrows) throw new Error("test"); return { error: null }; },
  };
  return { auth, calls };
}
test("password recovery rejects unknown fields, weak passwords and arbitrary target users", () => {
  assert.equal(recoveryCommand.safeParse({ action: "resetPassword", email: "bad" }).success, false);
  assert.equal(recoveryCommand.safeParse({ action: "changePassword", accountId, password: "short" }).success, false);
  assert.equal(recoveryCommand.safeParse({ action: "changePassword", accountId, password, userId: "another-user" }).success, false);
  assert.equal(recoveryCommand.safeParse({ action: "changePassword", accountId, password, mfaCode: "12345" }).success, false);
});
test("validates reset-link tokens and rejects passwords or extra account targets before redemption", () => {
  const command = { action: "resetWithLink", tokenHash: "pkce_" + "a".repeat(56), password };
  assert.deepEqual(recoveryCommand.parse(command), command);
  assert.equal(recoveryCommand.safeParse({ ...command, tokenHash: "a".repeat(56) }).success, true);
  for (const invalid of [
    { ...command, tokenHash: "javascript:example" },
    { ...command, tokenHash: "z".repeat(56) },
    { ...command, password: "short" },
    { ...command, accountId },
    { ...command, type: "magiclink" },
  ]) {
    assert.equal(recoveryCommand.safeParse(invalid).success, false);
  }
});
test("an absent session or unconfirmed email never changes a password", async () => {
  for (const options of [{ absent: true }, { unconfirmed: true }]) {
    const { auth, calls } = fixture(options);
    await assert.rejects(changeOwnPassword(auth, password), (e: unknown) => e instanceof RecoveryError && e.status === 401);
    assert.deepEqual(calls, []);
  }
});
test("an account without a staff role can recover only its own password", async () => {
  const { auth, calls } = fixture();
  assert.deepEqual(await recoveryAccount(auth), { accountId, email: "test@example.invalid", mfaRequired: false });
  assert.deepEqual(await changeOwnPassword(auth, password), { ok: true, signedOut: true });
  assert.deepEqual(calls, ["update-own-password", "sign-out-all"]);
});
test("verified MFA cannot be skipped with an AAL1 recovery session", async () => {
  const { auth, calls } = fixture({ mfa: true });
  assert.equal((await recoveryAccount(auth)).mfaRequired, true);
  await assert.rejects(changeOwnPassword(auth, password), (e: unknown) => e instanceof RecoveryError && e.status === 403);
  assert.deepEqual(calls, []);
});
test("switching accounts in another tab cannot change a different account's password", async () => {
  const { auth, calls } = fixture();
  await assert.rejects(completeRecovery(auth, {
    accountId: "10000000-0000-4000-8000-000000000002", password,
  }), (e: unknown) => e instanceof RecoveryError && e.status === 409);
  assert.deepEqual(calls, []);
});
test("failed MFA or a verification without AAL2 never updates credentials", async () => {
  for (const options of [{ verificationFails: true }, { verificationDoesNotElevate: true }]) {
    const { auth, calls } = fixture({ mfa: true, ...options });
    await assert.rejects(changeOwnPassword(auth, password, "123456"), RecoveryError);
    assert.deepEqual(calls, ["verify:own-factor"]);
  }
});
test("MFA verifies the server-selected factor before password update and global logout", async () => {
  const { auth, calls } = fixture({ mfa: true });
  await changeOwnPassword(auth, password, "123456");
  assert.deepEqual(calls, ["verify:own-factor", "update-own-password", "sign-out-all"]);
});
test("an already verified AAL2 session needs no redundant MFA challenge", async () => {
  const { auth, calls } = fixture({ mfa: true, aal2: true });
  await changeOwnPassword(auth, password);
  assert.deepEqual(calls, ["update-own-password", "sign-out-all"]);
});
test("assurance and factor lookup failures fail closed", async () => {
  for (const options of [{ levelFails: true }, { factorsFail: true }]) {
    const { auth, calls } = fixture(options);
    await assert.rejects(changeOwnPassword(auth, password), RecoveryError);
    assert.deepEqual(calls, []);
  }
});
test("failed password updates do not report success or sign out", async () => {
  const { auth, calls } = fixture({ updateFails: true });
  await assert.rejects(changeOwnPassword(auth, password), RecoveryError);
  assert.deepEqual(calls, ["update-own-password"]);
});
test("logout failure after a successful change is not reported as a failed password update", async () => {
  const { auth } = fixture({ logoutThrows: true });
  assert.deepEqual(await changeOwnPassword(auth, password), { ok: true, signedOut: false });
});

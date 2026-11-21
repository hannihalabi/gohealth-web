import { z } from "zod";
export const recoveryCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resetPassword"), email: z.email().max(254) }).strict(),
  z.object({
    action: z.literal("changePassword"),
    accountId: z.uuid(),
    password: z.string().min(12).max(200),
    mfaCode: z.string().regex(/^\d{6}$/).optional(),
  }).strict(),
  z.object({
    action: z.literal("resetWithLink"),
    tokenHash: z.string().regex(/^(?:pkce_)?[a-f0-9]{56}$/),
    password: z.string().min(12).max(200),
  }).strict(),
]);
export type RecoveryAccount = { accountId: string; email: string; mfaRequired: boolean };
export class RecoveryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type Outcome = { error: unknown };
export interface RecoveryAuth {
  getUser(): Promise<{ data: { user: { id: string; email?: string; email_confirmed_at?: string } | null }; error: unknown }>;
  mfa: {
    getAuthenticatorAssuranceLevel(): Promise<{ data: { currentLevel: string | null; nextLevel: string | null } | null; error: unknown }>;
    listFactors(): Promise<{ data: { totp: { id: string; status: string }[] } | null; error: unknown }>;
    challengeAndVerify(args: { factorId: string; code: string }): Promise<Outcome>;
  };
  updateUser(args: { password: string }): Promise<Outcome>;
  signOut(args: { scope: "global" }): Promise<Outcome>;
}
async function recoveryContext(auth: RecoveryAuth, expectedAccountId?: string) {
  // Identity comes from Auth. The form's account ID is only a precondition, never a target selector.
  const user = await auth.getUser();
  if (user.error || !user.data.user?.email || !user.data.user.email_confirmed_at)
    throw new RecoveryError(401, "Öppna återställningslänken i samma webbläsare som du begärde den från.");
  if (expectedAccountId && user.data.user.id !== expectedAccountId)
    throw new RecoveryError(409, "Kontot har bytts i webbläsaren. Öppna återställningslänken igen och kontrollera e-postadressen.");
  const [level, factors] = await Promise.all([
    auth.mfa.getAuthenticatorAssuranceLevel(), auth.mfa.listFactors(),
  ]);
  if (level.error || !level.data || factors.error || !factors.data)
    throw new RecoveryError(503, "Kontots verifiering kunde inte kontrolleras. Försök igen senare.");
  const factor = factors.data.totp.find((f) => f.status === "verified");
  const mfaRequired = level.data.currentLevel !== "aal2" &&
    (level.data.nextLevel === "aal2" || !!factor);
  if (mfaRequired && !factor)
    throw new RecoveryError(403, "Kontot kräver en annan tvåfaktorsmetod. Kontakta ansvarig administratör.");
  return { accountId: user.data.user.id, email: user.data.user.email, mfaRequired, factor };
}
export async function recoveryAccount(auth: RecoveryAuth): Promise<RecoveryAccount> {
  const { accountId, email, mfaRequired } = await recoveryContext(auth);
  return { accountId, email, mfaRequired };
}
export async function changeOwnPassword(auth: RecoveryAuth, input: { accountId: string; password: string; mfaCode?: string }) {
  const command = recoveryCommand.options[1].parse({ ...input, action: "changePassword" });
  const context = await recoveryContext(auth, command.accountId);
  if (context.mfaRequired) {
    if (!command.mfaCode || !context.factor)
      throw new RecoveryError(403, "Ange koden från kontots autentiseringsapp.");
    const verification = await auth.mfa.challengeAndVerify({ factorId: context.factor.id, code: command.mfaCode });
    if (verification.error)
      throw new RecoveryError(400, "Engångskoden kunde inte verifieras. Prova en ny kod.");
    const level = await auth.mfa.getAuthenticatorAssuranceLevel();
    if (level.error || level.data?.currentLevel !== "aal2")
      throw new RecoveryError(403, "Tvåfaktorsverifieringen behöver slutföras innan lösenordet ändras.");
  }
  const update = await auth.updateUser({ password: command.password });
  if (update.error)
    throw new RecoveryError(400, "Lösenordet kunde inte ändras. Välj ett nytt lösenord med minst 12 tecken och försök igen.");
  // Password recovery ends existing sessions, including sessions in the iOS app.
  let signedOut = false;
  try { signedOut = !(await auth.signOut({ scope: "global" })).error; }
  catch { /* The password is already changed; report logout failure truthfully. */ }
  return { ok: true, signedOut };
}

import { z } from "zod";
import { ApiError, failure, json, requestBody, requirePortalSurface, supabase } from "@/lib/server";
import { portalConfiguration } from "@/lib/portal-origins";
import { changeOwnPassword, recoveryAccount, recoveryCommand, RecoveryError } from "@/lib/recovery";
const credentials = {
  email: z.email().max(254),
  password: z.string().min(1).max(200),
};
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("login"), ...credentials }).strict(),
  z
    .object({
      action: z.literal("signup"),
      ...credentials,
      password: z.string().min(12).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("callback"),
      code: z.string().min(1).max(2048),
      flowId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/).optional(),
    })
    .strict(),
  z.object({ action: z.literal("accept"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("logout") }).strict(),
  ...recoveryCommand.options,
]);
async function current(db: Awaited<ReturnType<typeof supabase>>) {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user)
    throw new ApiError(401, "Logga in för att aktivera din behörighet.");
  if (!data.user.email_confirmed_at)
    throw new ApiError(403, "Bekräfta din e-postadress innan du fortsätter.");
  const invitations = await db.rpc("clinician_administration", {
    p_action: "pending",
    p_args: {},
  });
  if (invitations.error) throw invitations.error;
  return { email: data.user.email, invitations: invitations.data };
}
export async function GET(request: Request) {
  try {
    requirePortalSurface(request);
    if (new URL(request.url).searchParams.get("recovery") === "1")
      return json({ recovery: await recoveryAccount((await supabase()).auth) });
    return json(await current(await supabase()));
  } catch (e) {
    if (e instanceof RecoveryError) return json({ error: e.message }, e.status);
    if (e && typeof e === "object" && "issues" in e)
      return json(
        {
          error:
            "Kontrollera e-postadressen och lösenordet. Nya lösenord behöver minst 12 tecken.",
        },
        400,
      );
    if (e && typeof e === "object" && "code" in e && e.code === "42501")
      return json(
        {
          error:
            "Behörigheten kan inte aktiveras. Kontrollera att e-postadressen är bekräftad och att tilldelningen fortfarande gäller.",
        },
        403,
      );
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    const body = command.parse(await requestBody(request));
    const db = await supabase();
    if (body.action === "resetPassword") {
      const result = await db.auth.resetPasswordForEmail(body.email, {
        redirectTo: portalConfiguration().links.activation,
      });
      if (result.error)
        throw new ApiError(result.error.status === 429 ? 429 : 503,
          result.error.status === 429
            ? "För många mejlförsök. Vänta en stund innan du försöker igen."
            : "Återställningsmejlet kunde inte skickas. Försök senare eller kontakta ansvarig administratör.");
      // Same response for an existing or unknown address; sending does not grant access.
      return json({ ok: true });
    }
    if (body.action === "resetWithLink") {
      const { data, error } = await db.auth.verifyOtp({
        token_hash: body.tokenHash,
        type: "recovery",
      });
      if (error?.status === 429)
        throw new ApiError(429, "För många försök. Vänta en stund innan du försöker igen.");
      if (error || !data.session)
        throw new ApiError(400, "Länken kunde inte verifieras. Begär ett nytt återställningsmejl.");
      const recovery = await recoveryAccount(db.auth);
      if (recovery.accountId !== data.session.user.id)
        throw new ApiError(409, "Återställningskontot kunde inte verifieras. Begär ett nytt mejl.");
      if (recovery.mfaRequired) return json({ recovery });
      try {
        return json(await changeOwnPassword(db.auth, { accountId: recovery.accountId, password: body.password }));
      } catch (e) {
        // The link has been redeemed. A verified recovery session can retry the password update.
        if (e instanceof RecoveryError) return json({ recovery, passwordError: e.message });
        throw e;
      }
    }
    if (body.action === "changePassword")
      return json(await changeOwnPassword(db.auth, body));
    if (body.action === "logout") {
      const result = await db.auth.signOut({ scope: "local" });
      if (result.error) throw result.error;
      return json({ ok: true });
    }
    if (body.action === "signup") {
      const result = await db.auth.signUp({
        email: body.email,
        password: body.password,
        options: {
          emailRedirectTo: portalConfiguration().links.activation,
        },
      });
      if (result.error)
        throw new ApiError(
          400,
          "Kontot kunde inte registreras. Kontrollera uppgifterna eller försök senare.",
        );
      return json({ confirmationRequired: true });
    }
    if (body.action === "login") {
      const result = await db.auth.signInWithPassword({
        email: body.email,
        password: body.password,
      });
      if (result.error)
        throw new ApiError(
          401,
          "Inloggningen misslyckades. Kontrollera uppgifterna och att e-postadressen är bekräftad.",
        );
      return json(await current(db));
    }
    if (body.action === "callback") {
      const result = await db.auth.exchangeCodeForSession(body.code, body.flowId ? { flowId: body.flowId } : undefined);
      if (result.error)
        throw new ApiError(
          400,
          "Mejllänken kunde inte verifieras. Begär en ny länk via Glömt lösenord i GoHealth.",
        );
      if ("redirectType" in result.data && result.data.redirectType === "recovery")
        return json({ recovery: await recoveryAccount(db.auth) });
      return json(await current(db));
    }
    await current(db);
    const result = await db.rpc("clinician_administration", {
      p_action: "accept",
      p_args: { id: body.id },
    });
    if (result.error) throw result.error;
    return json(result.data);
  } catch (e) {
    if (e instanceof RecoveryError) return json({ error: e.message }, e.status);
    if (e && typeof e === "object" && "issues" in e)
      return json(
        {
          error:
            "Kontrollera e-postadressen och lösenordet. Nya lösenord behöver minst 12 tecken.",
        },
        400,
      );
    if (e && typeof e === "object" && "code" in e && e.code === "42501")
      return json(
        {
          error:
            "Behörigheten kan inte aktiveras. Kontrollera att e-postadressen är bekräftad och att tilldelningen fortfarande gäller.",
        },
        403,
      );
    return failure(e);
  }
}

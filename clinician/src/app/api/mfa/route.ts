import { z } from "zod";
import { ApiError, authorized, failure, json, requestBody } from "@/lib/server";
export async function POST(request: Request) {
  try {
    const body = z
      .object({
        action: z.enum(["prepare", "verify"]),
        factorId: z.uuid().optional(),
        code: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      })
      .strict()
      .parse(await requestBody(request));
    const { db, session } = await authorized();
    if (session.mfa_required === false)
      throw new ApiError(403, "Tvåfaktorsinloggning används inte i betan.");
    if (body.action === "verify") {
      if (!body.factorId || !body.code)
        return json({ error: "Ange sexsiffrig kod." }, 400);
      const { error } = await db.auth.mfa.challengeAndVerify({
        factorId: body.factorId,
        code: body.code,
      });
      if (error)
        return json(
          { error: "Koden kunde inte verifieras. Prova en ny kod." },
          400,
        );
      return json({ ok: true });
    }
    const factors = await db.auth.mfa.listFactors();
    if (factors.error) throw factors.error;
    const verified = factors.data.totp.find((x) => x.status === "verified");
    if (verified) return json({ factorId: verified.id });
    // Clear unfinished setup only. Verified factors can never be removed here.
    for (const factor of factors.data.all.filter(
      (x) => x.status === "unverified" && x.factor_type === "totp",
    )) {
      const removal = await db.auth.mfa.unenroll({ factorId: factor.id });
      if (removal.error) throw removal.error;
    }
    const result = await db.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "GoHealth vårdportal",
    });
    if (result.error) throw result.error;
    return json({
      factorId: result.data.id,
      qr: result.data.totp.qr_code,
      secret: result.data.totp.secret,
    });
  } catch (e) {
    return failure(e);
  }
}

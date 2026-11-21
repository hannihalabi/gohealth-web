import { z } from "zod";
import { authorized, failure, json, requestBody, supabase } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const { session } = await authorized();
    return json(session);
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    const body = z
      .object({
        action: z.enum(["login", "logout"]),
        email: z.email().optional(),
        password: z.string().max(200).optional(),
      })
      .strict()
      .parse(await requestBody(request));
    const db = await supabase();
    if (body.action === "logout") {
      const { error } = await db.auth.signOut({ scope: "local" });
      if (error) throw error;
      return json({ ok: true });
    }
    if (!body.email || !body.password)
      return json({ error: "Ange e-postadress och lösenord." }, 400);
    const { error } = await db.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });
    if (error)
      return json(
        {
          error: error.status === 429
            ? "För många inloggningsförsök. Vänta en stund innan du försöker igen."
            : "E-postadressen eller GoHealth-lösenordet kunde inte verifieras. Använd Glömt lösenord om du behöver ett nytt lösenord.",
        },
        error.status === 429 ? 429 : 401,
      );
    const session = await db.rpc("clinician_session");
    if (session.error || !(session.data?.access ?? session.data?.staff)) {
      await db.auth.signOut({ scope: "local" });
      return json(
        { error: "Kontot saknar aktiverad personalbehörighet. Öppna Aktivera din behörighet för att acceptera en väntande inbjudan." },
        403,
      );
    }
    return json(session.data);
  } catch (e) {
    return failure(e);
  }
}

import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { allowsPortalWrite, portalConfiguration, surfaceAllowsPath } from "./portal-origins";

export async function supabase() {
  const jar = await cookies();
  const url = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("CONFIGURATION");
  return createServerClient(url, key, {
    // Return the SDK's flow ID so activation looks up the verifier for that link.
    auth: { experimental: { appendPkceFlowIdToRedirects: true } },
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
    },
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (items) => {
        for (const { name, value, options } of items)
          jar.set(name, value, {
            ...options,
            domain: undefined,
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            path: "/",
          });
      },
    },
  });
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function requestBody(request: Request) {
  if (
    !allowsPortalWrite(
      request.headers.get("host"),
      request.headers.get("origin"),
      new URL(request.url).pathname,
      portalConfiguration(),
    )
  )
    throw new ApiError(
      403,
      "Begäran nekades. Öppna portalen på dess ordinarie adress.",
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new ApiError(415, "JSON krävs.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Tom begäran.");
  let bytes = 0,
    raw = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 128000) {
      await reader.cancel();
      throw new ApiError(413, "Begäran är för stor.");
    }
    raw += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(raw + decoder.decode());
  } catch {
    throw new ApiError(400, "Ogiltigt formulär.");
  }
}
export function requirePortalSurface(request: Request) {
  if (!surfaceAllowsPath(request.headers.get("host"), new URL(request.url).pathname, portalConfiguration()))
    throw new ApiError(403, "Öppna sidan på dess ordinarie adress.");
}
export async function authorized() {
  const db = await supabase();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw new ApiError(401, "Logga in igen.");
  const session = await db.rpc("clinician_session");
  if (session.error || !(session.data?.access ?? session.data?.staff))
    throw new ApiError(403, "Ditt konto saknar personalbehörighet.");
  return { db, user: data.user, session: session.data };
}
export function json(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
    },
  });
}
// Database refusals that the user can act on, in Swedish.
const knownMessages: Record<string, string> = {
  "No free times": "Du har inga lediga tider. Lägg in tider under Kalender först.",
  "Time booked": "Tiden är bokad. Avboka den i patientens chatt innan du tar bort den.",
  "Time unavailable": "Tiden finns inte längre.",
  "Booking unavailable": "Bokningen finns inte längre.",
  "Invalid time block": "Kontrollera tiderna. Blocket ska ligga framåt i tiden och ge högst 96 tider.",
  "Nothing to archive": "Chatten är redan stängd.",
  "Too many quick replies": "Du kan spara högst 50 egna snabbsvar.",
  "Patient app account required": "Patienten har inget verifierat appkonto.",
  "Invalid phone number": "Ange numret med siffror, till exempel 070-123 45 67.",
};
export function failure(error: unknown) {
  if (error instanceof ApiError)
    return json({ error: error.message }, error.status);
  if (error && typeof error === "object" && "issues" in error)
    return json(
      {
        error:
          "Kontrollera uppgifterna. Resultat, enhet och referensintervall måste vara korrekt angivna.",
      },
      400,
    );
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (code === "40001")
    return json(
      {
        error:
          "Uppgifterna har ändrats i en annan session. Uppdatera sidan innan du fortsätter.",
      },
      409,
    );
  if (code === "42501")
    return json(
      {
        error:
          "Åtkomst nekad. Kontrollera tvåfaktorsinloggning och vårdrelation.",
      },
      403,
    );
  const known =
    code === "22023" && error && typeof error === "object" && "message" in error
      ? knownMessages[String(error.message)]
      : undefined;
  if (known) return json({ error: known }, 400);
  if (code === "22023" || code === "23514" || code === "22P02")
    return json(
      { error: "Uppgifterna kunde inte godkännas. Kontrollera formuläret." },
      400,
    );
  return json(
    {
      error:
        "Åtgärden kunde inte genomföras. Försök igen eller kontakta administratören.",
    },
    500,
  );
}

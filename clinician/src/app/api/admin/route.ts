import { administrationCommand, portalSessionReady } from "@/lib/administration";
import { normalizeSearch } from "@/lib/model";
import { overviewRequest } from "@/lib/overview";
import { authorized, ApiError, failure, json, requestBody } from "@/lib/server";
export async function POST(request: Request) {
  try {
    const input = await requestBody(request);
    const body = input?.action === "overview" ? overviewRequest.parse(input) : administrationCommand.parse(input);
    const { db, session } = await authorized();
    if (!session.admin || !portalSessionReady(session))
      throw new ApiError(403, "Logga in med ditt administratörskonto för att fortsätta.");
    if (body.action === "overview") {
      const result = await db.rpc("clinician_system_overview", {
        p_organization_id: body.organizationId,
        p_member_portal: body.memberPortal,
        p_member_offset: body.memberOffset,
      });
      if (result.error) throw result.error;
      return json(result.data);
    }
    const { action, ...args } = body;
    if ("query" in args) args.query = normalizeSearch(args.query);
    if ("identity" in args) args.identity = normalizeSearch(args.identity);
    const result = await db.rpc("clinician_administration", {
      p_action: action,
      p_args: args,
    });
    if (result.error) throw result.error;
    return json(result.data);
  } catch (e) {
    if (e && typeof e === "object" && "issues" in e)
      return json(
        {
          error:
            "Kontrollera namn, e-postadress, roll och de obligatoriska bekräftelserna.",
        },
        400,
      );
    if (e && typeof e === "object" && "code" in e && e.code === "42501")
      return json(
        {
          error:
            "Administratörsåtkomst nekades. Kontrollera din aktuella mottagningsbehörighet.",
        },
        403,
      );
    if (
      e &&
      typeof e === "object" &&
      "message" in e &&
      e.message === "Patient account unavailable"
    )
      return json(
        {
          error:
            "Kontot behöver finnas och ha bekräftad e-post. En redan kopplad patient måste hanteras via mottagningens befintliga koppling eller ansvarig administratör.",
        },
        400,
      );
    return failure(e);
  }
}

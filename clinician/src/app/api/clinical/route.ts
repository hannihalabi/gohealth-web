import { z } from "zod";
import { ApiError, authorized, failure, json, requestBody } from "@/lib/server";
import { portalSessionReady } from "@/lib/administration";
import { ClinicalDateError, normalizeSearch, validatePayload, vitalKinds } from "@/lib/model";
const metricKinds = ["heart-rate","resting-heart-rate","hrv","hrv-rmssd","respiratory-rate","oxygen","vo2-max","weight","temperature","fev1","fvc","pef","steps","step-count","distance","active-energy","flights","sleep","sleep-awake","sleep-in-bed","workout"] as const;
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("vitals_overview"), patientId: z.uuid() }).strict(),
  z.object({ action: z.literal("vitals_page"), patientId: z.uuid(), kind: z.enum(metricKinds), cursor: z.object({ at: z.iso.datetime({offset:true}), id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) }).strict().nullable() }).strict(),
  z.object({ action: z.literal("list"), query: z.string().max(120) }).strict(),
  z.object({ action: z.literal("patient"), patientId: z.uuid() }).strict(),
  z.object({
    action: z.literal("vital_history"),
    patientId: z.uuid(),
    kind: z.enum(vitalKinds),
    beforeAt: z.iso.datetime({ offset: true }),
    beforeId: z.uuid(),
  }).strict(),
  z
    .object({
      action: z.literal("save"),
      patientId: z.uuid(),
      kind: z.enum(["lab", "vaccination", "imaging"]),
      payload: z.unknown(),
      recordId: z.uuid().nullable(),
      expectedRevision: z.number().int().min(0),
      replacesId: z.uuid().nullable(),
      correctionReason: z.string().trim().max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal("publish"),
      recordId: z.uuid(),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
]);
export async function POST(request: Request) {
  try {
    const body = command.parse(await requestBody(request));
    const { db, session } = await authorized();
    if (!(session.clinical ?? session.staff) || !portalSessionReady(session))
      throw new ApiError(403, "Logga in med ditt vårdgivarkonto för att fortsätta.");
    let result;
    switch (body.action) {
      case "vitals_overview":
      case "vitals_page":
        result = await db.rpc("clinician_vitals_v2", { p_patient: body.patientId, p_kind: body.action === "vitals_page" ? body.kind : null, p_cursor: body.action === "vitals_page" ? body.cursor : null });
        break;
      case "list":
        result = await db.rpc("clinician_list_patients", {
          p_query: normalizeSearch(body.query),
        });
        break;
      case "patient":
        result = await db.rpc("clinician_patient", {
          p_patient: body.patientId,
        });
        break;
      case "vital_history":
        result = await db.rpc("clinician_vital_history", {
          p_patient: body.patientId,
          p_kind: body.kind,
          p_before_at: body.beforeAt,
          p_before_id: body.beforeId,
        });
        break;
      case "save":
        result = await db.rpc("clinician_save_record", {
          p_patient: body.patientId,
          p_kind: body.kind,
          p_payload: validatePayload(body.kind, body.payload),
          p_id: body.recordId,
          p_revision: body.expectedRevision,
          p_replaces: body.replacesId,
          p_reason: body.correctionReason,
        });
        break;
      case "publish":
        result = await db.rpc("clinician_publish_record", {
          p_id: body.recordId,
          p_revision: body.expectedRevision,
        });
        break;
    }
    if (result.error) throw result.error;
    return json(result.data);
  } catch (e) {
    if (e instanceof ClinicalDateError) return failure(new ApiError(400, e.message));
    return failure(e);
  }
}

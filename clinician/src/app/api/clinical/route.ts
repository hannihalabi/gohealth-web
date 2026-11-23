import { z } from "zod";
import { ApiError, authorized, failure, json, requestBody } from "@/lib/server";
import { portalSessionReady } from "@/lib/administration";
import { CT_ARCHIVE_BUCKET } from "@/lib/ct-archive";
import { ClinicalDateError, normalizeSearch, validatePayload, vitalKinds } from "@/lib/model";

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("app_value_history"), patientId: z.uuid(), kind: z.string().min(1).max(200), cursor: z.object({at:z.iso.datetime({offset:true}),id:z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)}).strict().nullable() }).strict(),
  z.object({ action: z.literal("vitals_overview"), patientId: z.uuid() }).strict(),
  z.object({ action: z.literal("vitals_trend"), patientId: z.uuid(), days: z.number().int().min(1).max(40000), bucket: z.enum(["day", "week", "month"]).default("day") }).strict(),
  z.object({ action: z.literal("vitals_page"), patientId: z.uuid(), kind: z.string().min(1).max(200), cursor: z.object({ at: z.iso.datetime({offset:true}), id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) }).strict().nullable() }).strict(),
  z.object({ action: z.literal("list"), query: z.string().max(120) }).strict(),
  z.object({ action: z.literal("directory"), query: z.string().max(120) }).strict(),
  z.object({ action: z.literal("patient"), patientId: z.uuid() }).strict(),
  z.object({ action: z.literal("attestations") }).strict(),
  z.object({ action: z.literal("overview") }).strict(),
  z.object({ action: z.literal("inbox"), op: z.enum(["list", "poll"]) }).strict(),
  z.object({
    action: z.literal("messages"),
    op: z.enum(["thread", "send", "resolve", "poll"]),
    patientId: z.uuid(),
    body: z.string().trim().min(1).max(4000).optional(),
  }).strict(),
  z.object({
    action: z.literal("consultation"),
    op: z.enum(["colleagues", "send", "reply", "close"]),
    patientId: z.uuid().optional(),
    to: z.uuid().optional(),
    recordId: z.uuid().nullable().optional(),
    message: z.string().trim().min(1).max(2000).optional(),
    id: z.uuid().optional(),
    reply: z.string().trim().min(1).max(2000).optional(),
  }).strict(),
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
      action: z.literal("annul"),
      recordId: z.uuid(),
      reason: z.string().trim().min(1).max(500),
      confirm: z.literal("Ta bort"),
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
      case "app_value_history":
        result = await db.rpc("clinician_health_v3", { p_patient: body.patientId, p_kind: body.action === "vitals_overview" ? null : body.kind, p_cursor: body.action === "vitals_overview" ? null : body.cursor, p_mode: body.action === "vitals_overview" ? "overview" : body.action === "vitals_page" ? "raw" : "display" });
        break;
      case "vitals_trend":
        result = await db.rpc("clinician_health_trend", { p_patient: body.patientId, p_days: body.days, p_bucket: body.bucket });
        break;
      case "list":
        result = await db.rpc("clinician_patient_directory", {
          p_query: normalizeSearch(body.query),
          p_scope: "mine",
        });
        break;
      case "directory":
        result = await db.rpc("clinician_patient_directory", {
          p_query: normalizeSearch(body.query),
          p_scope: "all",
        });
        break;
      case "attestations":
        result = await db.rpc("clinician_pending_attestations");
        break;
      case "overview":
        result = await db.rpc("clinician_overview");
        break;
      case "inbox":
        result = await db.rpc("clinician_message_inbox", { p_action: body.op });
        break;
      case "messages":
        result = await db.rpc("clinician_patient_messages", {
          p_action: body.op,
          p_args: { patient: body.patientId, body: body.body },
        });
        break;
      case "consultation":
        result = await db.rpc("clinician_consultation", {
          p_action: body.op,
          p_args: { patient: body.patientId, to: body.to, record: body.recordId ?? null, message: body.message, id: body.id, reply: body.reply },
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
      case "annul": {
        result = await db.rpc("clinician_annul_record", {
          p_record: body.recordId,
          p_reason: body.reason,
          p_confirm: body.confirm,
        });
        const path = result.error ? undefined : (result.data as { path?: string } | null)?.path;
        if (path) {
          const { error } = await db.storage.from(CT_ARCHIVE_BUCKET).remove([path]);
          if (error)
            throw new ApiError(502, "Undersökningen är borttagen men bildfilen kunde inte raderas just nu. Försök ta bort igen.");
          result = { ...result, data: { ok: true } };
        }
        break;
      }
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


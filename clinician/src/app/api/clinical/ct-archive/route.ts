import { z } from "zod";
import { portalSessionReady } from "@/lib/administration";
import { CT_ARCHIVE_BUCKET, CT_ARCHIVE_MAX_BYTES, ctArchiveUploadOrigin } from "@/lib/ct-archive";
import { CtZipError, inspectCtZip } from "@/lib/ct-zip";
import { ApiError, authorized, failure, json, requestBody } from "@/lib/server";

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin"), patientId: z.uuid(), size: z.number().int().min(22).max(CT_ARCHIVE_MAX_BYTES) }),
  z.object({ action: z.literal("finish"), id: z.uuid() }),
  z.object({ action: z.literal("cancel"), id: z.uuid() }),
  z.object({ action: z.literal("download"), recordId: z.uuid(), inline: z.boolean().optional() }),
  z.object({ action: z.literal("remove"), recordId: z.uuid(), reason: z.string().trim().min(1).max(500) }),
]);

export async function POST(request: Request) {
  try {
    const parsed = command.safeParse(await requestBody(request));
    if (!parsed.success) throw new ApiError(400, "Begäran om ZIP-filen är ogiltig.");
    const body = parsed.data;
    const { db, session } = await authorized();
    if (!(session.clinical ?? session.staff) || !portalSessionReady(session))
      throw new ApiError(403, "Ditt konto saknar behörighet för bildutlåtanden.");
    const bucket = db.storage.from(CT_ARCHIVE_BUCKET);

    async function archive(action: string, args: Record<string, string | number>) {
      const { data, error } = await db.rpc("clinician_ct_archive", { p_action: action, p_args: args });
      if (error?.code === "42501") throw new ApiError(403, "Du saknar åtkomst till den här ZIP-filen.");
      if (error?.code === "22023") throw new ApiError(400, "ZIP-filen kunde inte godkännas. Kontrollera filen och försök igen.");
      if (error) throw error;
      return data;
    }

    switch (body.action) {
      case "begin": {
        const reservation = await archive("begin", { patientId: body.patientId, size: body.size });
        const { data, error } = await bucket.createSignedUploadUrl(reservation.path, { upsert: false });
        if (error) throw new ApiError(502, "Uppladdningen kunde inte startas. Försök igen.");
        return json({
          id: reservation.id,
          path: reservation.path,
          token: data.token,
          endpoint: `${ctArchiveUploadOrigin(process.env.SUPABASE_URL!)}/storage/v1/upload/resumable/sign`,
        });
      }
      case "finish": {
        const uploaded = await archive("inspect", { id: body.id });
        const { data, error } = await bucket.download(uploaded.path, {}, { cache: "no-store" });
        if (error) throw new ApiError(502, "Den uppladdade filen kunde inte läsas. Försök igen.");
        if (data.size !== uploaded.size || data.size > CT_ARCHIVE_MAX_BYTES)
          throw new ApiError(400, "Filstorleken stämmer inte. Välj ZIP-filen igen.");
        const { imageCount } = await inspectCtZip(data.size, async (start, length) =>
          new Uint8Array(await data.slice(start, start + length).arrayBuffer()),
        );
        await archive("finish", { id: body.id, imageCount });
        return json({ id: body.id, imageCount });
      }
      case "cancel": {
        const canceled = await archive("cancel", { id: body.id });
        const { error } = await bucket.remove([canceled.path]);
        if (error) throw new ApiError(502, "Uppladdningen avbröts men filen kunde inte tas bort just nu.");
        return json({ canceled: true });
      }
      case "download": {
        const attachment = await archive("read", { recordId: body.recordId });
        if (attachment.removed) return json(attachment);
        const { data, error } = await bucket.createSignedUrl(attachment.path, 60, body.inline ? undefined : { download: "bilder.zip" });
        if (error) throw new ApiError(502, "Filen kunde inte hämtas. Försök igen.");
        return json({ url: data.signedUrl, imageCount: attachment.imageCount, size: attachment.size });
      }
      case "remove": {
        const removed = await archive("remove", { recordId: body.recordId, reason: body.reason });
        const { error } = await bucket.remove([removed.path]);
        if (error) throw new ApiError(502, "Bilderna är markerade som borttagna men filen kunde inte raderas just nu. Försök igen.");
        return json({ removed: true });
      }
    }
  } catch (error) {
    if (error instanceof CtZipError) return failure(new ApiError(400, error.message));
    return failure(error);
  }
}

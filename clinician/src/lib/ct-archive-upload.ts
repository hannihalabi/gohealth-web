import { Upload } from "tus-js-client";
import { CT_ARCHIVE_BUCKET } from "./ct-archive";

export type CtArchiveUpload = {
  id: string;
  path: string;
  token: string;
  endpoint: string;
  uploadUrl?: string;
  uploaded?: boolean;
};

export class CtArchiveRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function ctArchiveRequest<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/clinical/ct-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null)
    throw new CtArchiveRequestError(response.status, data?.error || "ZIP-filen kunde inte hanteras just nu. Försök igen.");
  return data;
}

export function uploadCtArchive(file: File, reservation: CtArchiveUpload, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: reservation.endpoint,
      uploadUrl: reservation.uploadUrl ?? null,
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 700, 2000, 5000],
      headers: { "x-signature": reservation.token },
      metadata: {
        bucketName: CT_ARCHIVE_BUCKET,
        objectName: reservation.path,
        contentType: "application/zip",
        cacheControl: "0",
      },
      storeFingerprintForResuming: false,
      onProgress: (sent, total) => onProgress(Math.floor(sent / total * 100)),
      onError: () => {
        reservation.uploadUrl = upload.url ?? undefined;
        reject(new Error("Uppladdningen avbröts. Välj Spara utkast för att försöka igen."));
      },
      onSuccess: () => {
        reservation.uploaded = true;
        resolve();
      },
    });
    upload.start();
  });
}

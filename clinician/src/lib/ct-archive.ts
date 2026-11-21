export const CT_ARCHIVE_BUCKET = "clinical-ct-archives";
export const CT_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

export function ctArchiveUploadOrigin(supabaseUrl: string) {
  const url = new URL(supabaseUrl);
  const project = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1];
  return project ? `https://${project}.storage.supabase.co` : url.origin;
}

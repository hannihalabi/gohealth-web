// Reads ZIP archives in the browser: stored and deflated entries, no ZIP64.
// Archives are validated on upload (see ct-zip.ts), this only extracts what the viewer shows.
export type ZipEntry = { name: string; method: number; size: number; compressedSize: number; offset: number };

const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

export function readZipDirectory(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  let end = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP-filen kunde inte läsas.");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP-filen kunde inte läsas.");
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, p + 46, nameLength));
    if (!name.endsWith("/")) entries.push({ name, method, size, compressedSize, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function extractZipEntry(buffer: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.size > MAX_ENTRY_BYTES) throw new Error("En bildfil i ZIP-filen är för stor.");
  const view = new DataView(buffer);
  if (entry.offset + 30 > view.byteLength || view.getUint32(entry.offset, true) !== 0x04034b50) {
    throw new Error("ZIP-filen kunde inte läsas.");
  }
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = new Uint8Array(buffer, start, entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error("ZIP-filen använder en komprimering som inte stöds.");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

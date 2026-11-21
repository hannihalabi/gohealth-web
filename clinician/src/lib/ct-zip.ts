import { CT_ARCHIVE_MAX_BYTES } from "./ct-archive";

export const CT_ZIP_MAX_BYTES = CT_ARCHIVE_MAX_BYTES;

const maxEntries = 10_000;
const maxDirectoryBytes = 4 * 1024 * 1024;
const maxUncompressedBytes = 2 * 1024 * 1024 * 1024;
const endRecordBytes = 22;
const directoryHeaderBytes = 46;
const localHeaderBytes = 30;

const invalidZip = "Filen är inte ett komplett ZIP-arkiv som stöds.";
const unsupportedEntry = "ZIP-filen innehåller en filtyp som inte stöds. Använd ett arkiv med DICOM-, JPEG- eller PNG-bilder.";

export class CtZipError extends Error {}

type ReadRange = (start: number, length: number) => Promise<Uint8Array>;

async function readView(readRange: ReadRange, start: number, length: number): Promise<DataView> {
  const bytes = await readRange(start, length);
  if (bytes.byteLength !== length) throw new CtZipError(invalidZip);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndRecord(tail: DataView) {
  for (let offset = tail.byteLength - endRecordBytes; offset >= 0; offset--) {
    if (tail.getUint32(offset, true) === 0x06054b50 &&
        offset + endRecordBytes + tail.getUint16(offset + 20, true) === tail.byteLength) {
      return offset;
    }
  }
  throw new CtZipError(invalidZip);
}

function entryName(directory: DataView, offset: number, length: number, isUtf8: boolean) {
  const bytes = new Uint8Array(directory.buffer, directory.byteOffset + offset, length);
  const name = Buffer.from(bytes).toString(isUtf8 ? "utf8" : "latin1").normalize("NFC");
  const parts = name.replace(/\/$/, "").split("/");
  if (/[\x00-\x1f\x7f\\:]/.test(name) || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new CtZipError("ZIP-filen innehåller ett ogiltigt filnamn.");
  }
  return { name, parts };
}

function isImageFile(parts: string[]) {
  const name = parts[parts.length - 1];
  if (name === "DICOMDIR" || name === "README" || name === "LICENSE" || name === "THUMBS.DB" ||
      name === ".DS_STORE" || name.startsWith("._") || parts.includes("__MACOSX") || /\.(?:json|txt|xml|csv)$/i.test(name)) {
    return false;
  }
  if (/\.(?:dcm|dicom|ima|jpe?g|jpe|png)$/i.test(name) || /^\d+(?:\.\d+)+$/.test(name)) return true;
  // Some DICOM CDs omit file extensions on the image entries.
  if (/^(?:IM|IMG|I)\d+$/i.test(name) || (parts.slice(0, -1).includes("DICOM") && /^[A-Z\d_-]+$/i.test(name))) return true;
  throw new CtZipError(unsupportedEntry);
}

/** Checks the ZIP directory and sizes without extracting files or interpreting image contents. */
export async function inspectCtZip(size: number, readRange: ReadRange): Promise<{ imageCount: number }> {
  if (!Number.isSafeInteger(size) || size < endRecordBytes + localHeaderBytes) throw new CtZipError(invalidZip);
  if (size > CT_ZIP_MAX_BYTES) throw new CtZipError("ZIP-filen får vara högst 50 MB.");

  const tailOffset = Math.max(0, size - endRecordBytes - 0xffff);
  const tail = await readView(readRange, tailOffset, size - tailOffset);
  const endOffset = findEndRecord(tail);
  const entryCount = tail.getUint16(endOffset + 10, true);
  const directorySize = tail.getUint32(endOffset + 12, true);
  const directoryOffset = tail.getUint32(endOffset + 16, true);
  if (tail.getUint16(endOffset + 4, true) !== 0 || tail.getUint16(endOffset + 6, true) !== 0 ||
      tail.getUint16(endOffset + 8, true) !== entryCount || !entryCount || entryCount > maxEntries ||
      directorySize > maxDirectoryBytes || directorySize < directoryHeaderBytes * entryCount ||
      directoryOffset < localHeaderBytes || directoryOffset + directorySize !== tailOffset + endOffset) {
    throw new CtZipError(invalidZip);
  }

  const header = tailOffset === 0 ? tail : await readView(readRange, 0, 4);
  if (header.getUint32(0, true) !== 0x04034b50) throw new CtZipError(invalidZip);
  const directory = directoryOffset >= tailOffset
    ? new DataView(tail.buffer, tail.byteOffset + directoryOffset - tailOffset, directorySize)
    : await readView(readRange, directoryOffset, directorySize);

  const names = new Set<string>();
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  let imageCount = 0;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index++) {
    if (offset + directoryHeaderBytes > directorySize || directory.getUint32(offset, true) !== 0x02014b50) {
      throw new CtZipError(invalidZip);
    }
    const createdOn = directory.getUint8(offset + 5);
    const flags = directory.getUint16(offset + 8, true);
    const method = directory.getUint16(offset + 10, true);
    const compressed = directory.getUint32(offset + 20, true);
    const uncompressed = directory.getUint32(offset + 24, true);
    const nameLength = directory.getUint16(offset + 28, true);
    const extraLength = directory.getUint16(offset + 30, true);
    const commentLength = directory.getUint16(offset + 32, true);
    const attributes = directory.getUint32(offset + 38, true);
    const localOffset = directory.getUint32(offset + 42, true);
    const localEnd = localOffset + localHeaderBytes + nameLength + compressed;
    const nextOffset = offset + directoryHeaderBytes + nameLength + extraLength + commentLength;
    if (!nameLength || nextOffset > directorySize || localEnd > directoryOffset ||
        directory.getUint16(offset + 34, true) !== 0 || (method === 0 && compressed !== uncompressed)) {
      throw new CtZipError(invalidZip);
    }
    if ((flags & 0x2041) !== 0 || (method !== 0 && method !== 8)) {
      throw new CtZipError("Använd en vanlig ZIP-fil utan lösenordsskydd.");
    }

    const { name, parts } = entryName(directory, offset + directoryHeaderBytes, nameLength, (flags & 0x800) !== 0);
    const folder = name.endsWith("/");
    const fileType = (attributes >>> 16) & 0xf000;
    if ((createdOn === 3 || createdOn === 19) && fileType !== 0 && fileType !== (folder ? 0x4000 : 0x8000)) {
      throw new CtZipError("ZIP-filen innehåller en länk eller en filtyp som inte stöds.");
    }
    const nameKey = parts.join("/").toUpperCase();
    if (names.has(nameKey)) throw new CtZipError("ZIP-filen innehåller dubbla filnamn.");
    names.add(nameKey);
    ranges.push({ start: localOffset, end: localEnd });

    uncompressedTotal += uncompressed;
    if (uncompressedTotal > maxUncompressedBytes) throw new CtZipError("ZIP-filens innehåll är för stort.");
    if (!folder && isImageFile(parts.map((part) => part.toUpperCase()))) {
      if (!uncompressed || !compressed) throw new CtZipError("ZIP-filen innehåller en tom bildfil.");
      imageCount++;
    }
    offset = nextOffset;
  }

  ranges.sort((left, right) => left.start - right.start);
  if (offset !== directorySize || ranges[0].start !== 0 || ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) {
    throw new CtZipError(invalidZip);
  }
  if (!imageCount) throw new CtZipError("ZIP-filen behöver innehålla minst en DICOM-, JPEG- eller PNG-bild.");
  return { imageCount };
}

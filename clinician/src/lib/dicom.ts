// Minimal DICOM reader for the image viewer: uncompressed little-endian data and JPEG baseline.
export class DicomUnsupported extends Error {}

export type DicomImage = {
  rows: number;
  columns: number;
  samples: number;
  photometric: string;
  bitsAllocated: number;
  signed: boolean;
  slope: number;
  intercept: number;
  windowCenter?: number;
  windowWidth?: number;
  instance?: number;
  position?: number;
  seriesNumber?: number;
  seriesDescription?: string;
  modality?: string;
  /** Raw little-endian pixel bytes, or JPEG bytes when `jpeg` is true. */
  pixels: Uint8Array;
  jpeg: boolean;
};

const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UN", "UR", "UT"]);
const IMPLICIT = "1.2.840.10008.1.2";
const EXPLICIT_LE = "1.2.840.10008.1.2.1";
const JPEG_BASELINE = "1.2.840.10008.1.2.4.50";

export function looksLikeDicom(bytes: Uint8Array) {
  return bytes.length > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}

export function parseDicom(bytes: Uint8Array): DicomImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) =>
    new TextDecoder("latin1").decode(bytes.subarray(start, start + length)).replace(/[\0 ]+$/, "").trim();
  let p = looksLikeDicom(bytes) ? 132 : 0;
  let syntax = IMPLICIT;
  let explicit = false;
  const found: Record<string, string | number> = {};
  let pixels: Uint8Array | undefined;
  let jpeg = false;

  const readHeader = () => {
    const group = view.getUint16(p, true);
    const element = view.getUint16(p + 2, true);
    let vr = "";
    let length: number;
    let header = 8;
    if (group === 0xfffe) {
      length = view.getUint32(p + 4, true);
    } else if (explicit || group === 0x0002) {
      vr = String.fromCharCode(bytes[p + 4], bytes[p + 5]);
      if (LONG_VR.has(vr)) {
        length = view.getUint32(p + 8, true);
        header = 12;
      } else length = view.getUint16(p + 6, true);
    } else length = view.getUint32(p + 4, true);
    return { group, element, vr, length, header };
  };
  const skipUndefined = () => {
    // Skips a sequence with undefined length by counting nested delimiters.
    let depth = 1;
    while (p + 8 <= bytes.length && depth > 0) {
      const g = view.getUint16(p, true);
      const e = view.getUint16(p + 2, true);
      const l = view.getUint32(p + 4, true);
      p += 8;
      if (g === 0xfffe && (e === 0xe000 || e === 0xe0dd || e === 0xe00d)) {
        if (e === 0xe0dd) depth--;
        else if (e === 0xe000 && l === 0xffffffff) depth++;
        else if (e === 0xe000) p += l;
      } else if (l !== 0xffffffff) p += l;
      else depth++;
    }
  };

  let metaEnded = false;
  while (p + 8 <= bytes.length) {
    const { group, element, vr, length, header } = readHeader();
    if (group !== 0x0002 && !metaEnded) {
      metaEnded = true;
      if (syntax === EXPLICIT_LE || syntax === JPEG_BASELINE) explicit = true;
      else if (syntax !== IMPLICIT) throw new DicomUnsupported("DICOM-formatet stöds inte i förhandsvisningen.");
      continue; // re-read this element with the right syntax
    }
    const tag = group * 65536 + element;
    if (group === 0x7fe0 && element === 0x0010) {
      if (length === 0xffffffff) {
        p += header;
        const fragments: Uint8Array[] = [];
        let first = true;
        while (p + 8 <= bytes.length) {
          const l = view.getUint32(p + 4, true);
          const e = view.getUint16(p + 2, true);
          p += 8;
          if (e === 0xe0dd) break;
          if (!first) fragments.push(bytes.subarray(p, p + l));
          first = false;
          p += l;
        }
        if (syntax !== JPEG_BASELINE) throw new DicomUnsupported("Komprimerat DICOM-format stöds inte i förhandsvisningen.");
        const total = fragments.reduce((sum, f) => sum + f.length, 0);
        pixels = new Uint8Array(total);
        let at = 0;
        for (const f of fragments) {
          pixels.set(f, at);
          at += f.length;
        }
        jpeg = true;
      } else {
        pixels = bytes.subarray(p + header, p + header + length);
      }
      break;
    }
    if (length === 0xffffffff) {
      p += header;
      skipUndefined();
      continue;
    }
    const start = p + header;
    switch (tag) {
      case 0x00020010: syntax = text(start, length); break;
      case 0x00280002: case 0x00280010: case 0x00280011: case 0x00280100: case 0x00280103:
        found[tag] = explicit || group === 0x0002 ? view.getUint16(start, true) : view.getUint16(start, true); break;
      case 0x00280004: found[tag] = text(start, length); break;
      case 0x00281050: case 0x00281051: case 0x00281052: case 0x00281053: case 0x00200032:
      case 0x00200013: case 0x00200011:
        found[tag] = text(start, length); break;
      case 0x0008103e: case 0x00080060: found[tag] = text(start, length); break;
    }
    p = start + length;
    void vr;
  }
  if (!pixels) throw new DicomUnsupported("Bilden saknar pixeldata.");
  const num = (tag: number) => {
    const value = found[tag];
    if (typeof value === "number") return value;
    const n = parseFloat(String(value ?? "").split("\\")[0]);
    return Number.isFinite(n) ? n : undefined;
  };
  const position = typeof found[0x00200032] === "string" ? parseFloat(String(found[0x00200032]).split("\\")[2]) : undefined;
  const samples = (found[0x00280002] as number) ?? 1;
  const bitsAllocated = (found[0x00280100] as number) ?? 16;
  if (!jpeg && (samples !== 1 && samples !== 3 || (bitsAllocated !== 8 && bitsAllocated !== 16))) {
    throw new DicomUnsupported("Bildformatet stöds inte i förhandsvisningen.");
  }
  return {
    rows: (found[0x00280010] as number) ?? 0,
    columns: (found[0x00280011] as number) ?? 0,
    samples,
    photometric: String(found[0x00280004] ?? "MONOCHROME2"),
    bitsAllocated,
    signed: found[0x00280103] === 1,
    slope: num(0x00281053) ?? 1,
    intercept: num(0x00281052) ?? 0,
    windowCenter: num(0x00281050),
    windowWidth: num(0x00281051),
    instance: num(0x00200013),
    position: Number.isFinite(position) ? position : undefined,
    seriesNumber: num(0x00200011),
    seriesDescription: found[0x0008103e] ? String(found[0x0008103e]) : undefined,
    modality: found[0x00080060] ? String(found[0x00080060]) : undefined,
    pixels,
    jpeg,
  };
}

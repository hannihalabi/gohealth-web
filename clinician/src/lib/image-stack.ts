import { DicomUnsupported, looksLikeDicom, parseDicom, type DicomImage } from "./dicom";
import { extractZipEntry, readZipDirectory } from "./zip-reader";

export type Slice =
  | { kind: "gray"; width: number; height: number; values: Float32Array; invert: boolean; center: number; windowWidth: number; order: [number, number, string] }
  | { kind: "bitmap"; width: number; height: number; bitmap: ImageBitmap; order: [number, number, string] };
export type Series = { id: string; title: string; slices: Slice[] };

const SKIP = /(^|\/)(DICOMDIR|README|LICENSE|THUMBS\.DB|\.DS_STORE|__MACOSX\/.*|\._.*)$|\.(json|txt|xml|csv)$/i;
const natural = new Intl.Collator("sv", { numeric: true });

function grayFromDicom(image: DicomImage, order: Slice["order"]): Slice {
  const { rows, columns, pixels, bitsAllocated, signed, slope, intercept } = image;
  const count = rows * columns;
  const view = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const values = new Float32Array(count);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const raw = bitsAllocated === 8 ? pixels[i] : signed ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true);
    const v = raw * slope + intercept;
    values[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const hasWindow = image.windowWidth !== undefined && image.windowWidth > 0;
  return {
    kind: "gray",
    width: columns,
    height: rows,
    values,
    invert: image.photometric === "MONOCHROME1",
    center: hasWindow ? (image.windowCenter ?? (min + max) / 2) : (min + max) / 2,
    windowWidth: hasWindow ? image.windowWidth! : Math.max(1, max - min),
    order,
  };
}

async function bitmapFrom(bytes: Uint8Array, type: string, order: Slice["order"]): Promise<Slice> {
  const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer], { type }));
  return { kind: "bitmap", width: bitmap.width, height: bitmap.height, bitmap, order };
}

/** Reads every image in an archive and groups them into series in reading order. */
export async function loadSeries(
  archive: ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<{ series: Series[]; skipped: number }> {
  const entries = readZipDirectory(archive).filter((e) => !SKIP.test(e.name)).sort((a, b) => natural.compare(a.name, b.name));
  const groups = new Map<string, { title: string; number: number; slices: Slice[] }>();
  let skipped = 0;
  let done = 0;
  for (const entry of entries) {
    try {
      const bytes = await extractZipEntry(archive, entry);
      let slice: Slice | undefined;
      let key = "bilder";
      let title = "Bilder";
      let number = 0;
      const fallback: Slice["order"] = [0, done, entry.name];
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) slice = await bitmapFrom(bytes, "image/png", fallback);
      else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) slice = await bitmapFrom(bytes, "image/jpeg", fallback);
      else if (looksLikeDicom(bytes) || /\.(dcm|dicom|ima)$/i.test(entry.name) || !/\./.test(entry.name.split("/").pop() ?? "")) {
        const image = parseDicom(bytes);
        number = image.seriesNumber ?? 0;
        title = image.seriesDescription || (image.seriesNumber ? `Serie ${image.seriesNumber}` : "Bilder");
        key = `${number}|${title}`;
        const order: Slice["order"] = [image.position ?? image.instance ?? done, image.instance ?? done, entry.name];
        slice = image.jpeg ? await bitmapFrom(image.pixels, "image/jpeg", order) : grayFromDicom(image, order);
      }
      if (!slice) skipped++;
      else {
        const group = groups.get(key) ?? { title, number, slices: [] };
        group.slices.push(slice);
        groups.set(key, group);
      }
    } catch (error) {
      if (error instanceof DicomUnsupported && done === 0 && entries.length === 1) throw error;
      skipped++;
    }
    onProgress?.(++done, entries.length);
  }
  const series = [...groups.entries()]
    .sort((a, b) => a[1].number - b[1].number || natural.compare(a[1].title, b[1].title))
    .map(([id, g]) => ({
      id,
      title: g.title,
      slices: g.slices.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || natural.compare(a.order[2], b.order[2])),
    }));
  if (!series.length) throw new DicomUnsupported("Inga bilder i ZIP-filen kunde visas. Hämta ZIP-filen och öppna den i en DICOM-läsare.");
  return { series, skipped };
}

/** Synthetic brain-like phantom for the demonstration environment. */
export function demoSeries(): Series[] {
  const width = 256;
  const height = 256;
  const slices: Slice[] = [];
  for (let z = 0; z < 36; z++) {
    const values = new Float32Array(width * height);
    const radius = Math.sin(((z + 3) / 42) * Math.PI);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = (x - 128) / (96 * radius + 1);
        const dy = (y - 132) / (112 * radius + 1);
        const r = dx * dx + dy * dy;
        let v = 0;
        if (r < 1.0) v = 320; // skull and scalp
        if (r < 0.86) v = 560; // brain tissue
        if (r < 0.62) v = 700;
        const vx = (x - 128) / (16 + 10 * radius);
        const vy = (y - 124) / (30 * radius + 1);
        if (r < 0.7 && Math.abs(vx) > 0.5 && Math.abs(vx) < 2.4 && vy * vy + (Math.abs(vx) - 1.4) ** 2 < 0.9) v = 120; // ventricles
        v += ((x * 7919 + y * 104729 + z * 1299709) % 41) - 20;
        values[y * width + x] = v;
      }
    }
    slices.push({ kind: "gray", width, height, values, invert: false, center: 450, windowWidth: 900, order: [z, z, String(z)] });
  }
  return [{ id: "demo", title: "T2 AX (syntetisk)", slices }];
}

import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { looksLikeDicom, parseDicom } from "../src/lib/dicom";
import { extractZipEntry, readZipDirectory } from "../src/lib/zip-reader";

function element(group: number, el: number, vr: string, value: Uint8Array | string | number) {
  let body: Uint8Array;
  if (typeof value === "number") {
    body = new Uint8Array(2);
    new DataView(body.buffer).setUint16(0, value, true);
  } else if (typeof value === "string") {
    const text = new TextEncoder().encode(value);
    body = text.length % 2 ? Uint8Array.from([...text, 0x20]) : text;
  } else body = value;
  const long = ["OB", "OW", "SQ", "UT"].includes(vr);
  const header = new Uint8Array(long ? 12 : 8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, el, true);
  header[4] = vr.charCodeAt(0);
  header[5] = vr.charCodeAt(1);
  if (long) view.setUint32(8, body.length, true);
  else view.setUint16(6, body.length, true);
  return Uint8Array.from([...header, ...body]);
}
function dicom(instance: number, pixels: number[]) {
  const px = new Uint8Array(pixels.length * 2);
  pixels.forEach((v, i) => new DataView(px.buffer).setInt16(i * 2, v, true));
  const parts = [
    new Uint8Array(128),
    new TextEncoder().encode("DICM"),
    element(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1"),
    element(0x0008, 0x0060, "CS", "MR"),
    element(0x0008, 0x103e, "LO", "T2 AX"),
    element(0x0020, 0x0011, "IS", "3"),
    element(0x0020, 0x0013, "IS", String(instance)),
    element(0x0028, 0x0002, "US", 1),
    element(0x0028, 0x0004, "CS", "MONOCHROME2"),
    element(0x0028, 0x0010, "US", 2),
    element(0x0028, 0x0011, "US", 2),
    element(0x0028, 0x0100, "US", 16),
    element(0x0028, 0x0103, "US", 1),
    element(0x0028, 0x1050, "DS", "40\\60"),
    element(0x0028, 0x1051, "DS", "400"),
    element(0x0028, 0x1052, "DS", "-1024"),
    element(0x0028, 0x1053, "DS", "1"),
    element(0x7fe0, 0x0010, "OW", px),
  ];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}
function zip(files: { name: string; data: Uint8Array; deflate?: boolean }[]) {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = new TextEncoder().encode(f.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, f.deflate ? 8 : 0, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(10, f.deflate ? 8 : 0, true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, f.data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    chunks.push(local, new Uint8Array(body));
    central.push(dir);
    offset += local.length + body.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const all = Uint8Array.from([...chunks, ...central, end].flatMap((c) => [...c]));
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

test("DICOM reader returns geometry, window, ordering keys and signed pixels", () => {
  const image = parseDicom(dicom(7, [-1000, 0, 100, 1000]));
  assert.equal(image.rows, 2);
  assert.equal(image.columns, 2);
  assert.equal(image.signed, true);
  assert.equal(image.windowCenter, 40);
  assert.equal(image.windowWidth, 400);
  assert.equal(image.intercept, -1024);
  assert.equal(image.instance, 7);
  assert.equal(image.seriesNumber, 3);
  assert.equal(image.seriesDescription, "T2 AX");
  assert.equal(image.modality, "MR");
  assert.equal(new DataView(image.pixels.buffer, image.pixels.byteOffset).getInt16(0, true), -1000);
  assert.ok(looksLikeDicom(dicom(1, [0, 0, 0, 0])));
});

test("ZIP reader extracts stored and deflated entries", async () => {
  const a = dicom(1, [1, 2, 3, 4]);
  const b = new TextEncoder().encode("PNGDATA".repeat(50));
  const buffer = zip([{ name: "IM1", data: a }, { name: "dir/IM2.png", data: b, deflate: true }]);
  const entries = readZipDirectory(buffer);
  assert.deepEqual(entries.map((e) => e.name), ["IM1", "dir/IM2.png"]);
  assert.deepEqual([...(await extractZipEntry(buffer, entries[0]))], [...a]);
  assert.deepEqual([...(await extractZipEntry(buffer, entries[1]))], [...b]);
  assert.throws(() => readZipDirectory(new ArrayBuffer(10)));
});

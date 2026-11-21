import assert from "node:assert/strict";
import { test } from "node:test";
import { CT_ZIP_MAX_BYTES, CtZipError, inspectCtZip } from "../src/lib/ct-zip";

// Small ZIP generated with Python's zipfile, with two image entries and one AppleDouble entry.
const exampleZip = Buffer.from(
  "UEsDBBQAAAAIAABgdV2SWeo+DAAAAAoAAAANAAAARElDT00vSU0wMDAwMQtJLS5RcPF09vcFAFBLAwQUAAAACAAAYHVd9PntIAsAAAAJAAAACwAAAHByZXZpZXcuanBnC0ktLlHwCnB1BwBQSwMEFAAAAAgAAGB1XUKx6EgNAAAACwAAABYAAABfX01BQ09TWC8uX3ByZXZpZXcuanBncywoyEl1yS9NykkFAFBLAQIUAxQAAAAIAABgdV2SWeo+DAAAAAoAAAANAAAAAAAAAAAAAACAAQAAAABESUNPTS9JTTAwMDAxUEsBAhQDFAAAAAgAAGB1XfT57SALAAAACQAAAAsAAAAAAAAAAAAAAIABNwAAAHByZXZpZXcuanBnUEsBAhQDFAAAAAgAAGB1XUKx6EgNAAAACwAAABYAAAAAAAAAAAAAAIABawAAAF9fTUFDT1NYLy5fcHJldmlldy5qcGdQSwUGAAAAAAMAAwC4AAAArAAAAAAA",
  "base64",
);

const inspect = (zip: Buffer) => inspectCtZip(zip.length, async (start, length) => zip.subarray(start, start + length));

test("CT ZIP inspection counts JPEG and extensionless DICOM and skips macOS metadata", async () => {
  assert.deepEqual(await inspect(exampleZip), { imageCount: 2 });
});

test("CT ZIP inspection rejects missing, truncated, and unsafe directory entries", async () => {
  await assert.rejects(inspect(exampleZip.subarray(0, -1)), CtZipError);
  const invalidHeader = Buffer.from(exampleZip);
  invalidHeader[0] = 0;
  await assert.rejects(inspect(invalidHeader), CtZipError);
  const unsafeName = Buffer.from(exampleZip);
  const centralDirectory = unsafeName.readUInt32LE(unsafeName.length - 6);
  unsafeName.write("../", centralDirectory + 46);
  await assert.rejects(inspect(unsafeName), /ogiltigt filnamn/);
});

test("CT ZIP inspection rejects files over the storage limit before fetching data", async () => {
  let read = false;
  await assert.rejects(inspectCtZip(CT_ZIP_MAX_BYTES + 1, async () => {
    read = true;
    return new Uint8Array();
  }), /högst 50 MB/);
  assert.equal(read, false);
});

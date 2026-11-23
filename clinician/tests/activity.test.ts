import assert from "node:assert/strict";
import test from "node:test";
import { activityLabel, deviceName, toCsv } from "../src/lib/activity";

test("known actions get Swedish labels and unknown ones keep their code", () => {
  assert.equal(activityLabel("patient.open"), "Öppnade journalen");
  assert.equal(activityLabel("auth.session"), "Inloggning");
  assert.equal(activityLabel("future.action"), "future.action");
});
test("device names are read from the user agent", () => {
  assert.equal(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"), "Chrome · macOS");
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari · iOS");
  assert.equal(deviceName(null), "");
});
test("CSV cells are quoted and escaped", () => {
  assert.equal(toCsv([["Tid", "Namn"], ["2026-11-23", 'Hanni "Dr" Halabi, läkare']]), '"Tid","Namn"\r\n"2026-11-23","Hanni ""Dr"" Halabi, läkare"');
});

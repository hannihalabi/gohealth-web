import assert from "node:assert/strict";
import test from "node:test";
import { historySentence, isChange } from "../src/lib/history";

const base = { id: 1, at: "2026-11-24T09:23:00Z", actor: "Hanni Halabi", role: "doctor", record: null };
test("changes read as sentences with name, role, record and time", () => {
  assert.equal(
    historySentence({ ...base, action: "record.publish", record: { id: "r", kind: "lab", title: "Blodprover", status: "published", revision: 2 } }),
    'Hanni Halabi (Läkare) granskade och publicerade provsvar "Blodprover" 2026-11-24 10:23',
  );
  assert.equal(historySentence({ ...base, action: "messages.archive", role: "nurse" }), "Hanni Halabi (Sjuksköterska) stängde chatten 2026-11-24 10:23");
  assert.equal(historySentence({ ...base, action: "record.annul" }), "Hanni Halabi (Läkare) tog bort en post 2026-11-24 10:23");
});
test("unknown actors and actions are still shown, and only edits count as changes", () => {
  assert.match(historySentence({ ...base, actor: null, role: null, action: "something.new" }), /^Okänd användare something\.new /);
  assert.ok(isChange("record.publish") && isChange("booking.book"));
  assert.ok(!isChange("patient.open") && !isChange("messages.read"));
});

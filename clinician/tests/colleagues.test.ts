import assert from "node:assert/strict";
import test from "node:test";
import { initials, matchesColleague, sortColleagues, telHref, validPhone, workloadLevel, workloadShare, type Colleague } from "../src/lib/colleagues";

const person = (name: string, role: string, patients: number | null = null, team: string | null = null): Colleague => ({
  id: name, organization: "Klinik", name, role, email: name.toLowerCase().replace(/\W+/g, ".") + "@example.invalid",
  phone: null, self: false, patients, teamSize: null, team,
});

test("workload colours: green under 50, yellow from 50, red from 100", () => {
  assert.equal(workloadLevel(0), "ok");
  assert.equal(workloadLevel(49), "ok");
  assert.equal(workloadLevel(50), "busy");
  assert.equal(workloadLevel(99), "busy");
  assert.equal(workloadLevel(100), "full");
  assert.equal(workloadLevel(140), "full");
  assert.equal(workloadShare(140), 1);
  assert.equal(workloadShare(25), 0.25);
});

test("doctors first by default, busiest first by workload", () => {
  const list = [person("Ö Nurse", "nurse", null, "Dr. A"), person("Dr. Berg", "doctor", 20), person("Dr. Ahl", "doctor", 80), person("Anna", "secretary")];
  assert.deepEqual(sortColleagues(list, "role").map((c) => c.name), ["Dr. Ahl", "Dr. Berg", "Ö Nurse", "Anna"]);
  assert.deepEqual(sortColleagues(list, "workload").map((c) => c.name), ["Dr. Ahl", "Dr. Berg", "Anna", "Ö Nurse"]);
  assert.deepEqual(sortColleagues(list, "name").map((c) => c.name), ["Anna", "Dr. Ahl", "Dr. Berg", "Ö Nurse"]);
});

test("search matches name, team and role without accents", () => {
  const nurse = person("Åsa Ström", "nurse", null, "Dr. Hanna Ek");
  assert.ok(matchesColleague(nurse, "asa", "Sjuksköterska"));
  assert.ok(matchesColleague(nurse, "hanna", "Sjuksköterska"));
  assert.ok(matchesColleague(nurse, "sjukskoterska", "Sjuksköterska"));
  assert.ok(!matchesColleague(nurse, "läkare", "Sjuksköterska"));
});

test("phone numbers dial cleanly and are validated like the database", () => {
  assert.equal(telHref("+46 70-123 45 67"), "tel:+46701234567");
  assert.equal(telHref("070-123 45 67"), "tel:0701234567");
  assert.ok(validPhone(" 070-123 45 67 "));
  assert.ok(!validPhone("call me"));
  assert.ok(!validPhone("12"));
  assert.equal(initials("Dr. Sofia Lind"), "SL");
  assert.equal(initials("Anna"), "A");
});

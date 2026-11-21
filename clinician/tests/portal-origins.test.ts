import { test } from "node:test";
import assert from "node:assert/strict";
import { allowsPortalWrite, portalConfiguration, portalSurface } from "../src/lib/portal-origins";
const clinical = "https://clinician.hemlakare.se";
const administration = "https://admin.hemlakare.se";
const split = portalConfiguration({ APP_ORIGIN: clinical, ADMIN_ORIGIN: administration });
test("separate hosts open the appropriate workspace and canonical activation", () => {
  assert.equal(portalSurface("admin.hemlakare.se", split), "administration");
  assert.equal(portalSurface("CLINICIAN.hemlakare.se", split), "clinical");
  assert.deepEqual(split.links, {
    clinical: clinical + "/", administration: administration + "/",
    activation: administration + "/activate", separateDomains: true,
  });
});
test("writes bind the full origin to the actual host, including sibling domains", () => {
  for (const path of ["/api/auth", "/api/mfa"]) {
    assert.equal(allowsPortalWrite("admin.hemlakare.se", administration, path, split), true);
    assert.equal(allowsPortalWrite("admin.hemlakare.se", clinical, path, split), false);
    assert.equal(allowsPortalWrite("clinician.hemlakare.se", administration, path, split), false);
    assert.equal(allowsPortalWrite("clinician.hemlakare.se", clinical, path, split), true);
  }
});
test("clinical and administrative mutations remain on their own hosts", () => {
  assert.equal(allowsPortalWrite("admin.hemlakare.se", administration, "/api/clinical", split), false);
  assert.equal(allowsPortalWrite("admin.hemlakare.se", administration, "/api/clinical/ct-archive", split), false);
  assert.equal(allowsPortalWrite("clinician.hemlakare.se", clinical, "/api/clinical/ct-archive", split), true);
  assert.equal(allowsPortalWrite("clinician.hemlakare.se", clinical, "/api/admin", split), false);
  assert.equal(allowsPortalWrite("clinician.hemlakare.se", clinical, "/api/activation", split), false);
  assert.equal(allowsPortalWrite("admin.hemlakare.se", administration, "/api/admin", split), true);
  assert.equal(allowsPortalWrite("admin.hemlakare.se", administration, "/api/activation", split), true);
});
test("unknown hosts, missing origins and lookalike domains cannot write", () => {
  for (const host of [null, "gohealth-clinician.vercel.app", "admin.hemlakare.se.evil.test", "admin.hemlakare.se,evil.test"]) {
    assert.equal(allowsPortalWrite(host, administration, "/api/auth", split), false);
  }
  for (const origin of [null, "null", administration + ".evil.test", administration + "/", "http://admin.hemlakare.se", administration + ":444"]) {
    assert.equal(allowsPortalWrite("admin.hemlakare.se", origin, "/api/auth", split), false);
  }
});
test("shared local development keeps both workspaces and checks ports", () => {
  const config = portalConfiguration({ APP_ORIGIN: "http://127.0.0.1:3040" });
  assert.equal(config.links.separateDomains, false);
  assert.equal(config.links.administration, "http://127.0.0.1:3040/admin");
  for (const path of ["/api/admin", "/api/clinical", "/api/activation"]) {
    assert.equal(allowsPortalWrite("127.0.0.1:3040", "http://127.0.0.1:3040", path, config), true);
    assert.equal(allowsPortalWrite("127.0.0.1:3041", "http://127.0.0.1:3040", path, config), false);
    assert.equal(allowsPortalWrite("127.0.0.1:3040", "http://localhost:3040", path, config), false);
  }
});
test("untrusted or ambiguous origin configuration fails closed", () => {
  for (const APP_ORIGIN of ["http://admin.hemlakare.se", administration + "/path", administration + "?next=evil", "https://user:password@admin.hemlakare.se", "not-a-url"]) {
    assert.throws(() => portalConfiguration({ APP_ORIGIN }));
  }
  assert.throws(() => portalConfiguration({ APP_ORIGIN: "http://localhost:3040", ADMIN_ORIGIN: "https://localhost:3040" }));
});

import type { ClinicalRecord, Patient, PatientDetail } from "./model";
import type { HomeData } from "./clinician-home";
export const demoPatients: Patient[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    display_name: "Alex Lind",
    identity_label: "TEST-0001",
    identity_verified: true,
    last_sync_at: "2026-11-17T08:20:00Z",
    doctors: ["Amir · testläkare"],
    assigned_to_me: true,
    can_open: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    display_name: "Kim Berg",
    identity_label: "TEST-0002",
    identity_verified: true,
    last_sync_at: null,
    doctors: ["Amir · testläkare"],
    assigned_to_me: true,
    can_open: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    display_name: "Robin Holm",
    identity_label: "TEST-0003",
    identity_verified: false,
    last_sync_at: null,
    doctors: [],
    assigned_to_me: true,
    can_open: true,
  },
];
/** Directory-only patient: visible to the whole clinic, but not assigned to the signed-in clinician. */
export const demoOtherPatients: Patient[] = [
  {
    id: "00000000-0000-4000-8000-000000000004",
    display_name: "Sam Ek",
    identity_label: "TEST-0004",
    identity_verified: true,
    last_sync_at: "2026-11-16T14:05:00Z",
    doctors: ["Dr. Berg"],
    assigned_to_me: false,
    can_open: true,
  },
];
export function demoDetail(patient: Patient): PatientDetail {
  const active = patient.id === demoPatients[0].id;
  const record: ClinicalRecord = {
    id: "00000000-0000-4000-8000-000000000101",
    patient_id: patient.id,
    kind: "lab",
    status: "published",
    version: 1,
    revision: 1,
    replaces_id: null,
    superseded_at: null,
    published_at: "2026-11-13T10:00:00Z",
    created_at: "2026-11-13T09:00:00Z",
    correction_reason: null,
    payload: {
      title: "Hälsouppföljning",
      sampledAt: "2026-11-12T08:00:00Z",
      source: "Syntetiskt laboratorium",
      comment: "Exempelsvar för att prova registrering och presentation.",
      observations: [
        {
          code: "tsh",
          name: "TSH",
          value: "3.2",
          comparator: "=",
          unit: "mIE/L",
          referenceLow: 0.4,
          referenceHigh: 4,
          referenceText: "",
        },
        {
          code: "alt",
          name: "ALAT",
          value: "0.45",
          comparator: "=",
          unit: "µkat/L",
          referenceLow: 0.15,
          referenceHigh: 0.75,
          referenceText: "",
        },
      ],
    },
  };
  const mr: ClinicalRecord = {
    ...record,
    id: "00000000-0000-4000-8000-000000000102",
    kind: "imaging",
    published_at: "2026-11-14T10:00:00Z",
    payload: {
      title: "MR hjärna",
      sampledAt: "2026-11-14T08:30:00Z",
      source: "Syntetisk bildtjänst",
      comment: "",
      observations: [],
      modality: "MR",
      bodyPart: "Hjärna",
      conclusion: "Syntetiskt exempel. Inga fokala förändringar.",
      studyId: "",
      archiveId: "00000000-0000-4000-8000-0000000001a2",
    },
  };
  const followUp: ClinicalRecord = {
    ...record,
    id: "00000000-0000-4000-8000-000000000104",
    published_at: "2026-11-16T10:00:00Z",
    payload: {
      ...record.payload,
      title: "Uppföljning sköldkörtel",
      sampledAt: "2026-11-15T08:00:00Z",
      observations: [
        { code: "tsh", name: "TSH", value: "7.1", comparator: "=", unit: "mIE/L", referenceLow: 0.4, referenceHigh: 4, referenceText: "" },
        { code: "free-t4", name: "Fritt T4", value: "9", comparator: "=", unit: "pmol/L", referenceLow: 12, referenceHigh: 22, referenceText: "" },
        { code: "ldl", name: "LDL-kolesterol", value: "3.1", comparator: "=", unit: "mmol/L", referenceLow: null, referenceHigh: 3, referenceText: "" },
      ],
    },
  };
  const draft: ClinicalRecord = {
    ...record,
    id: "00000000-0000-4000-8000-000000000103",
    status: "draft",
    published_at: null,
    payload: { ...record.payload, title: "Vitaminstatus", observations: [] },
  };
  return {
    patient,
    records: active ? [record, followUp, mr, draft] : [],
    vitals: active
      ? Array.from({ length: 14 }, (_, i) => ({
          id: `demo-${i}`,
          kind: "resting-heart-rate",
          value: 58 + [3, 0, 2, 1, 4, 2, 0][i % 7],
          unit: "beats/min",
          start_at: new Date(Date.UTC(2026, 10, 17 - i, 6)).toISOString(),
          end_at: new Date(Date.UTC(2026, 10, 17 - i, 6)).toISOString(),
          source: "Syntetisk klocka",
          definition: "resting-heart-rate",
          deleted_at: null,
        })).concat(Array.from({ length: 14 }, (_, i) => ({
          id: `demo-steps-${i}`,
          kind: "steps",
          value: 7000 + [1263, 630, -1490, 320, 903, -550, 1400][i % 7],
          unit: "count",
          start_at: new Date(Date.UTC(2026, 10, 17 - i)).toISOString(),
          end_at: new Date(Date.UTC(2026, 10, 18 - i)).toISOString(),
          calendar_day: new Date(Date.UTC(2026, 10, 17 - i)).toISOString().slice(0, 10),
          source: "Syntetiska steg från Apple Hälsa",
          definition: "steps-daily",
          deleted_at: null,
        }))).concat(([
          ["hrv", "ms", [48, 52, 45, 50, 55, 47, 51], 1],
          ["weight", "kg", [82.4, 82.1, 82.3, 81.9, 81.8, 82.0, 81.7], 1],
          ["oxygen", "%", [97, 98, 97, 96, 98, 97, 98], 1],
        ] as const).flatMap(([kind, unit, base]) => Array.from({ length: 14 }, (_, i) => ({
          id: `demo-${kind}-${i}`,
          kind,
          value: base[(13 - i) % 7] + (13 - i > 7 ? 0 : 0.4),
          unit,
          start_at: new Date(Date.UTC(2026, 10, 17 - i, 7)).toISOString(),
          end_at: new Date(Date.UTC(2026, 10, 17 - i, 7)).toISOString(),
          source: "Syntetisk klocka",
          definition: kind,
          deleted_at: null,
        }))))
      : [],
    audit: [],
  };
}
export function demoPublish(
  records: ClinicalRecord[],
  id: string,
  now: string,
): ClinicalRecord[] {
  const selected = records.find((x) => x.id === id);
  if (!selected || selected.status !== "draft")
    throw new Error("Utkastet saknas.");
  if (
    selected.replaces_id &&
    !records.some(
      (x) =>
        x.id === selected.replaces_id &&
        x.status === "published" &&
        !x.superseded_at,
    )
  )
    throw new Error("Originalet har redan rättats.");
  return records.map((x) =>
    x.id === id
      ? {
          ...x,
          status: "published",
          published_at: now,
          revision: x.revision + 1,
        }
      : x.id === selected.replaces_id
        ? { ...x, superseded_at: now }
        : x,
  );
}

/** Synthetic start page for the demonstration environment. Meetings are placed around today so the agenda is alive. */
export function demoHome(): HomeData {
  const [a, b, c] = demoPatients;
  const other = demoOtherPatients[0];
  const at = (days: number, hour: number, minute = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  const plus20 = (iso: string) => new Date(Date.parse(iso) + 20 * 60000).toISOString();
  const meeting = (id: string, p: { id: string; display_name: string }, iso: string, visit: "video" | "phone" | "clinic") =>
    ({ id, patient_id: p.id, display_name: p.display_name, visit_type: visit, starts_at: iso, ends_at: plus20(iso) });
  const dayOnly = (days: number) => at(days, 12).slice(0, 10);
  return {
    role: "doctor",
    counts: { assigned: demoPatients.length, clinic: demoPatients.length + demoOtherPatients.length, unsigned: 1, consultations: 1, messages: 1, review: 3 },
    messages: [{ patient_id: a.id, display_name: a.display_name, body: "Tack! Behöver jag ta om sköldkörtelprovet?", created_at: at(0, 7, 42), waiting: 1 }],
    unsigned: [{ id: "demo-unsigned-1", patient_id: a.id, display_name: a.display_name, kind: "lab", title: "Uppföljande sköldkörtelprov", created_at: at(-1, 9) }],
    announcements: [{ id: "demo-announcement-1", title: "Influensavaccination", body: "Säsongens vaccination startar på måndag. Prioritera patienter i riskgrupp.", created_at: at(-2, 8), author: "Administratör" }],
    consultations: [{
      id: "demo-consultation-1", patient_id: other.id, display_name: other.display_name, direction: "in", status: "open",
      message: "Kan du titta på vilopulsen? Den har stigit den senaste veckan.", reply: null, created_at: at(-1, 7, 30), replied_at: null,
      from_name: "Dr. Berg", to_name: null, record: null,
    }],
    deviations: [
      { patient_id: b.id, display_name: b.display_name, rule: "oxygen", category: "vitals", severity: "high", title: "Låg syremättnad",
        detail: "Lägsta 89 % senaste 7 dagarna", at: dayOnly(-1), key: "oxygen:demo", data: { recent: 89, low: 92, unit: "%", direction: "down" } },
      { patient_id: a.id, display_name: a.display_name, rule: "resting-heart-rate", category: "vitals", severity: "warn", title: "Stigande vilopuls",
        detail: "71 slag/min senaste 7 dagarna mot 62 slag/min tidigare", at: dayOnly(0), key: "rhr:demo", data: { recent: 71, base: 62, unit: "slag/min", direction: "up" } },
      { patient_id: a.id, display_name: a.display_name, rule: "lab", category: "lab", severity: "warn", title: "Provsvar utanför referens",
        detail: "TSH 6.8 mIE/L", at: dayOnly(-3), key: "lab:demo:tsh", data: { name: "TSH", value: 6.8, unit: "mIE/L", low: 0.4, high: 4, direction: "high" } },
      { patient_id: c.id, display_name: c.display_name, rule: "lab", category: "lab", severity: "warn", title: "Provsvar utanför referens",
        detail: "Hemoglobin 112 g/L", at: dayOnly(-6), key: "lab:demo:hb", data: { name: "Hemoglobin", value: 112, unit: "g/L", low: 117, high: 153, direction: "low" },
        reviewed_at: at(-2, 14), reviewed_by: "Dr. Berg" },
      { patient_id: c.id, display_name: c.display_name, rule: "sync", category: "sync", severity: "info", title: "Ingen datasynk",
        detail: "Senaste synk för 21 dagar sedan", at: dayOnly(-21), key: "sync:demo" },
    ],
    agenda: [
      meeting("demo-m1", a, at(0, 9, 20), "video"),
      meeting("demo-m2", b, at(0, 13, 0), "phone"),
      meeting("demo-m3", c, at(2, 10, 40), "clinic"),
      meeting("demo-m4", other, at(6, 9, 0), "video"),
      meeting("demo-m5", b, at(-5, 11, 0), "phone"),
    ],
    followups: [
      { patient_id: c.id, display_name: c.display_name, last_at: at(-41, 10), next_at: null, next_visit_type: null, due_on: dayOnly(-11) },
      { patient_id: b.id, display_name: b.display_name, last_at: null, next_at: null, next_visit_type: null, due_on: null },
      { patient_id: a.id, display_name: a.display_name, last_at: at(-28, 9), next_at: at(0, 9, 20), next_visit_type: "video", due_on: dayOnly(2) },
    ],
  };
}

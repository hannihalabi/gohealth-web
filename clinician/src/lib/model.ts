import { z } from "zod";

export const catalog = [
  { code: "tsh", name: "TSH", unit: "mIE/L", organ: "thyroid" },
  { code: "free-t4", name: "Fritt T4", unit: "pmol/L", organ: "thyroid" },
  { code: "alt", name: "ALAT", unit: "µkat/L", organ: "liver" },
  { code: "ast", name: "ASAT", unit: "µkat/L", organ: "liver" },
  { code: "creatinine", name: "Kreatinin", unit: "µmol/L", organ: "kidneys" },
  { code: "egfr", name: "eGFR", unit: "mL/min/1,73 m²", organ: "kidneys" },
  { code: "apob", name: "Apolipoprotein B", unit: "g/L", organ: "heart" },
  { code: "ldl", name: "LDL-kolesterol", unit: "mmol/L", organ: "heart" },
  {
    code: "total-cholesterol",
    name: "Totalkolesterol",
    unit: "mmol/L",
    organ: "heart",
  },
  { code: "hba1c", name: "HbA1c", unit: "mmol/mol", organ: "other" },
  { code: "hemoglobin", name: "Hemoglobin", unit: "g/L", organ: "other" },
] as const;
const text = (max: number) => z.string().trim().min(1).max(max);
export const observationSchema = z
  .object({
    code: z.enum(catalog.map((x) => x.code)),
    name: text(120),
    value: text(120),
    comparator: z.enum(["=", "<", ">", "<=", ">=", "text"]),
    unit: z.string().trim().max(80),
    referenceLow: z.number().finite().nullable(),
    referenceHigh: z.number().finite().nullable(),
    referenceText: z.string().trim().max(300),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.comparator !== "text" && !v.unit)
      c.addIssue({
        code: "custom",
        message: "Ange originalsvarets enhet.",
        path: ["unit"],
      });
    if (v.comparator !== "text" && !/^-?\d+(\.\d+)?$/.test(v.value))
      c.addIssue({
        code: "custom",
        message: "Ange ett giltigt tal.",
        path: ["value"],
      });
    if (
      v.referenceLow !== null &&
      v.referenceHigh !== null &&
      v.referenceLow > v.referenceHigh
    )
      c.addIssue({ code: "custom", message: "Referensintervallet är omvänt." });
  });
const base = {
  title: text(160),
  sampledAt: z.iso.datetime({ offset: true }),
  source: text(160),
  comment: z.string().trim().max(4000),
};
export const labSchema = z
  .object({ ...base, observations: z.array(observationSchema).min(1).max(100) })
  .strict()
  .superRefine((v, c) => {
    if (
      new Set(v.observations.map((x) => x.code)).size !== v.observations.length
    )
      c.addIssue({
        code: "custom",
        message: "En analys får bara förekomma en gång per rapport.",
      });
  });
export const vaccinationSchema = z
  .object({
    ...base,
    vaccine: text(120),
    dose: text(80),
    batch: z.string().trim().max(80),
    location: text(160),
  })
  .strict();
export const imagingSchema = z
  .object({
    ...base,
    modality: z.enum(["CT", "MR", "US", "XR", "OTHER"]),
    bodyPart: text(120),
    conclusion: text(8000),
    studyId: z.union([z.uuid(), z.literal("")]),
    archiveId: z.uuid().optional(),
  })
  .strict();
export const payloadSchemas = {
  lab: labSchema,
  vaccination: vaccinationSchema,
  imaging: imagingSchema,
};
export type Kind = keyof typeof payloadSchemas;
export type Observation = z.infer<typeof observationSchema>;
export type Payload = z.infer<typeof labSchema> &
  Partial<z.infer<typeof vaccinationSchema> & z.infer<typeof imagingSchema>>;
export type ClinicalRecord = {
  id: string;
  patient_id: string;
  kind: Kind;
  status: "draft" | "published";
  version: number;
  revision: number;
  replaces_id: string | null;
  superseded_at: string | null;
  payload: Payload;
  published_at: string | null;
  created_at: string;
  correction_reason: string | null;
};
export type Patient = {
  id: string;
  display_name: string;
  identity_label: string;
  identity_verified: boolean;
  last_sync_at: string | null;
};
export type Vital = {
  id: string;
  kind: string;
  value: number | null;
  unit: string;
  start_at: string;
  end_at: string;
  source: string;
  definition: string;
  deleted_at: string | null;
  calendar_day?: string | null;
};
export const vitalKinds = ["heart-rate", "resting-heart-rate", "sleep", "steps"] as const;
export const vitalPageSize = 100;
export type PatientDetail = {
  patient: Patient;
  records: ClinicalRecord[];
  vitals: Vital[];
  audit: { action: string; created_at: string }[];
};
export function displayStatus(o: Observation) {
  if (o.comparator !== "=" || !Number.isFinite(Number(o.value))) return "Mätt";
  const n = Number(o.value);
  if (
    (o.referenceLow !== null && n < o.referenceLow) ||
    (o.referenceHigh !== null && n > o.referenceHigh)
  )
    return "Utanför intervall";
  return o.referenceLow !== null || o.referenceHigh !== null
    ? "Inom intervall"
    : "Mätt";
}
export class ClinicalDateError extends Error {
  constructor(kind: Kind) {
    super({
      lab: "Provtagningstiden ligger för långt fram. Ange när provet togs.",
      vaccination: "Vaccinationstiden ligger för långt fram. Ange när vaccinationen gjordes.",
      imaging: "Undersökningstiden ligger för långt fram. Ange när undersökningen gjordes.",
    }[kind]);
  }
}

export function validatePayload(kind: Kind, payload: unknown) {
  const record = payloadSchemas[kind].parse(payload);
  // Match the database's one-day tolerance before uploading any attachments.
  if (Date.parse(record.sampledAt) > Date.now() + 24 * 60 * 60 * 1000)
    throw new ClinicalDateError(kind);
  return record;
}
export function normalizeSearch(value: string) {
  return value.trim().replace(/^(\d{8})[-+ ]?(\d{4})$/, "$1$2");
}
export function parseLocalDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Välj datum och klockslag.");
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  )
    throw new Error("Datumet eller tiden är ogiltig.");
  return date.toISOString();
}
export function isSameOrigin(origin: string | null, expected: string) {
  try {
    return (
      origin !== null && new URL(origin).origin === new URL(expected).origin
    );
  } catch {
    return false;
  }
}

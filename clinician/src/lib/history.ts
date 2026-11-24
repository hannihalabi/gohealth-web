// Patient history as sentences: "Hanni Halabi (Läkare) granskade och publicerade provsvar 2026-11-24 10:23".
export type HistoryEvent = {
  id: number | string;
  at: string;
  action: string;
  actor: string | null;
  role: string | null;
  record: { id: string; kind: string; title: string | null; status: string; revision: number } | null;
};
const kindNames: Record<string, string> = { lab: "provsvar", vaccination: "vaccination", imaging: "bilddiagnostik" };
const roleNames: Record<string, string> = {
  doctor: "Läkare", nurse: "Sjuksköterska", psychologist: "Psykolog", secretary: "Medicinsk sekreterare", admin: "Administratör", patient: "Patient",
};
/** Actions that change something. Everything else is access (opening, reading). */
const changes: Record<string, string> = {
  "record.save_draft": "sparade utkast till",
  "record.publish": "granskade och publicerade",
  "record.annul": "tog bort",
  "record.remove_ct_archive": "raderade bildarkivet för",
  "messages.send": "skickade ett meddelande till patienten",
  "messages.resolve": "markerade patientens meddelanden som hanterade",
  "messages.archive": "stängde chatten",
  "messages.patient_send": "skrev till vårdteamet",
  "booking.request": "bad patienten boka tid",
  "booking.cancel": "avbokade patientens tid",
  "booking.book": "bokade en tid",
  "booking.unbook": "avbokade sin tid",
  "consultation.send": "skickade en konsultation om patienten",
  "consultation.reply": "svarade på en konsultation om patienten",
  "consultation.close": "avslutade en konsultation om patienten",
};
const access: Record<string, string> = {
  "patient.open": "öppnade journalen",
  "patient.read_published": "läste publicerade uppgifter",
  "patient.read_health_trend": "läste trender",
  "patient.all_app_values_overview": "öppnade vitalparametrar",
  "patient.read_all_app_values": "läste mätvärden",
  "patient.health_history_overview": "öppnade hälsohistorik",
  "patient.read_health_history": "läste hälsohistorik",
  "patient.open_vital_history": "läste vitalhistorik",
  "patient.read_history": "läste historiken",
  "messages.read": "läste meddelanden",
  "record.download_ct_archive": "öppnade bildarkivet för",
  "patient.sync_vitals": "synkade hälsodata",
  "patient.sync_all_app_values": "synkade hälsodata",
  "patient.sync_health_history": "synkade hälsohistorik",
};
export const isChange = (action: string) => action in changes;

export function roleName(role: string | null) {
  return role ? (roleNames[role] ?? role) : null;
}
export function recordName(r: HistoryEvent["record"]) {
  if (!r) return "";
  const kind = kindNames[r.kind] ?? r.kind;
  return r.title ? `${kind} "${r.title}"` : kind;
}
export function whenText(iso: string) {
  return new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
/** The sentence without name and time, e.g. "granskade och publicerade provsvar "Blodprover"". */
export function verbText(e: Pick<HistoryEvent, "action" | "record">) {
  const base = changes[e.action] ?? access[e.action] ?? e.action;
  const rec = recordName(e.record);
  const needsRecord = ["record.save_draft", "record.publish", "record.annul", "record.remove_ct_archive", "record.download_ct_archive"].includes(e.action);
  return needsRecord ? `${base} ${rec || "en post"}` : base;
}
/** "Hanni Halabi (Läkare) granskade och publicerade provsvar "X" 2026-11-24 10:23" */
export function historySentence(e: HistoryEvent) {
  const who = e.actor ? `${e.actor}${e.role ? ` (${roleName(e.role)})` : ""}` : "Okänd användare";
  return `${who} ${verbText(e)} ${whenText(e.at)}`;
}

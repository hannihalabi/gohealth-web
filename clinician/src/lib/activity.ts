/** Human-readable labels for logged actions. Unknown actions fall back to their code so nothing is hidden. */
const labels: Record<string, string> = {
  // Journal
  "patient.open": "Öppnade journalen",
  "patient.search": "Sökte patient",
  "patient.read_health_trend": "Läste trender",
  "patient.all_app_values_overview": "Öppnade vitalparametrar",
  "patient.read_all_app_values": "Läste mätvärden",
  "patient.health_history_overview": "Öppnade hälsohistorik",
  "patient.read_health_history": "Läste hälsohistorik",
  "patient.open_vital_history": "Läste vitalhistorik",
  "record.save_draft": "Sparade utkast",
  "record.publish": "Publicerade",
  "record.annul": "Tog bort undersökning",
  "record.remove_ct_archive": "Raderade bildarkiv",
  "record.download_ct_archive": "Öppnade bildarkiv",
  "messages.send": "Skickade meddelande till patienten",
  "messages.read": "Läste meddelanden",
  "messages.resolve": "Markerade meddelanden hanterade",
  "messages.inbox": "Öppnade inkorgen",
  "consultation.send": "Skickade konsultation",
  "consultation.reply": "Svarade på konsultation",
  "consultation.close": "Avslutade konsultation",
  "clinician.overview": "Öppnade översikten",
  // Administration
  "administration.open": "Öppnade administrationen",
  "administration.invite": "Lade till personal för aktivering",
  "administration.cancelInvitation": "Återkallade väntande behörighet",
  "administration.member": "Ändrade personalbehörighet",
  "administration.patient": "Kopplade patientkonto",
  "administration.assignment": "Ändrade patienttilldelning",
  "administration.careTeam": "Ändrade teamkoppling",
  "administration.staff_linked": "Personal kopplad",
  "administration.bootstrapPrepared": "Kliniken förbereddes",
  "administration.activity_review": "Granskade aktivitetsloggen",
  "administration.signupapprove": "Godkände patientregistrering",
  "administration.signupreject": "Avslog patientregistrering",
  "administration.applicationhandled": "Hanterade ansökan",
  "administration.applicationdismissed": "Avfärdade ansökan",
  "announcement.post": "Publicerade meddelande till personalen",
  "announcement.archive": "Arkiverade meddelande till personalen",
  "invitation.accept": "Aktiverade sin behörighet",
  // Sign-in
  "auth.session": "Inloggning",
};
export function activityLabel(action: string) {
  return labels[action] ?? action;
}
export const activityCategories = { journal: "Journal", admin: "Administration", login: "Inloggning" } as const;
export type ActivityCategory = keyof typeof activityCategories;

/** Short device name from a browser user agent. */
export function deviceName(userAgent?: string | null) {
  if (!userAgent) return "";
  const os = /iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Mac OS X|Macintosh/.test(userAgent) ? "macOS"
    : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox"
    : /Safari\//.test(userAgent) ? "Safari" : /GoHealth/.test(userAgent) ? "GoHealth-appen" : "";
  return [browser, os].filter(Boolean).join(" · ") || userAgent.slice(0, 40);
}

/** CSV with a header row; every cell quoted, so commas, quotes and line breaks in names survive. */
export function toCsv(rows: string[][]) {
  return rows.map((r) => r.map((c) => `"${String(c ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

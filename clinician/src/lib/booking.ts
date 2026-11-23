// Booking in the chat: visit types, built-in quick replies and calendar date helpers.
// Dates are plain "YYYY-MM-DD" strings for the clinic's time zone, so arithmetic never shifts a day.
export type VisitType = "video" | "phone" | "clinic";
export const visitTypes: Record<VisitType, string> = {
  video: "Videosamtal",
  phone: "Telefonsamtal",
  clinic: "Besök på mottagningen",
};
export const builtInQuickReplies = [
  "Tack för ditt meddelande. Jag återkommer så snart jag kan.",
  "Dina provsvar ser bra ut. Inga åtgärder behövs just nu.",
  "Jag vill gärna träffa dig. Boka en tid via knappen här i chatten.",
  "Om du blir sämre, ring 1177. Vid akuta besvär, ring 112.",
  "Tack, då avslutar jag chatten. Hör av dig igen om något förändras.",
];

const zone = "Europe/Stockholm";
const days = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"];
const months = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

/** Today's date (or the given instant's) in Stockholm. */
export function stockholmDate(at: Date = new Date()): string {
  return at.toLocaleDateString("sv-SE", { timeZone: zone });
}
export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The Monday of the week the date falls in. */
export function weekStart(date: string): string {
  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}
export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
export function dayLabel(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: zone });
}
/** "tis 25 nov 09:20–09:40" */
export function timeRange(start: string, end: string | null): string {
  return `${dayLabel(stockholmDate(new Date(start)))} ${clock(start)}${end ? "–" + clock(end) : ""}`;
}
/** How many times a block such as 09:00–12:00 in 20-minute times gives. */
export function slotCount(from: string, to: string, minutes: number): number {
  const m = (t: string) => {
    const [h, mm] = t.split(":").map(Number);
    return h * 60 + mm;
  };
  if (!/^\d\d:\d\d$/.test(from) || !/^\d\d:\d\d$/.test(to) || !(minutes > 0)) return 0;
  return Math.max(0, Math.floor((m(to) - m(from)) / minutes));
}

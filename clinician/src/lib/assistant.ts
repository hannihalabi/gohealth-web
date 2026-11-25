// The start page assistant: a short spoken summary of the day, built from the overview data in the portal.
// No external AI service is called and nothing leaves the system.
import type { HomeData, HomeFollowup } from "./clinician-home";

export type Mood = "calm" | "busy" | "alert";
export type FocusTarget = "deviations" | "review" | "drafts" | "messages" | "consultations" | "followups" | "agenda";
export type Focus = { target: FocusTarget; label: string; count: number; tone: "alert" | "warn" | "calm" };
export type Briefing = { greeting: string; mood: Mood; lines: string[]; focus: Focus[] };

const zone = "Europe/Stockholm";
const visit: Record<string, string> = { video: "videosamtal", phone: "telefonsamtal", clinic: "besök" };
const dayKey = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: zone });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: zone });
const dayText = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short", timeZone: zone });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function list(names: string[]) {
  const unique = [...new Set(names)];
  if (unique.length <= 2) return unique.join(" och ");
  return `${unique.slice(0, 2).join(", ")} och ${unique.length - 2} till`;
}

export function greetingFor(now: Date) {
  const hour = Number(now.toLocaleString("sv-SE", { hour: "2-digit", hour12: false, timeZone: zone }));
  return hour < 5 ? "God natt" : hour < 10 ? "God morgon" : hour < 18 ? "God eftermiddag" : "God kväll";
}

/** Patients whose monthly follow-up is late or due within a week and not booked. */
export function followupsDue(followups: HomeFollowup[] = [], now = new Date()) {
  const today = dayKey(now);
  const soon = dayKey(new Date(now.getTime() + 7 * 86400000));
  return followups.filter((f) => !f.next_at && (!f.due_on || f.due_on <= soon)).map((f) => ({
    ...f, overdue: !f.due_on || f.due_on < today,
  }));
}

export function buildBriefing(data: HomeData, name: string, now = new Date()): Briefing {
  const first = name.replace(/\s*\(.*\)\s*$/, "").split(/\s+/)[0] || name;
  const greeting = `${greetingFor(now)}, ${first}`;
  const lines: string[] = [];
  const focus: Focus[] = [];
  const today = dayKey(now);

  const meetings = (data.agenda ?? []).filter((m) => dayKey(new Date(m.starts_at)) === today);
  const upcoming = (data.agenda ?? []).filter((m) => new Date(m.ends_at) > now);
  if (meetings.length) {
    const left = meetings.filter((m) => new Date(m.ends_at) > now);
    lines.push(`Du har ${plural(meetings.length, "möte", "möten")} idag${left.length && left.length < meetings.length ? `, ${left.length} kvar` : ""}: `
      + meetings.slice(0, 3).map((m) => `${clock(m.starts_at)} ${m.display_name} (${visit[m.visit_type] ?? m.visit_type})`).join(", ")
      + (meetings.length > 3 ? " med flera." : "."));
    focus.push({ target: "agenda", label: "Dagens möten", count: meetings.length, tone: "calm" });
  } else if (upcoming.length) {
    lines.push(`Inga möten idag. Nästa är ${dayText(upcoming[0].starts_at)} ${clock(upcoming[0].starts_at)} med ${upcoming[0].display_name}.`);
  }

  const deviations = data.deviations ?? [];
  const high = deviations.filter((d) => d.severity === "high" && !d.reviewed_at);
  if (high.length) {
    lines.push(`Viktigast först: ${list(high.map((d) => `${d.display_name} (${d.title.toLowerCase()})`))}.`);
  }
  const toReview = deviations.filter((d) => !d.reviewed_at && d.category !== "sync");
  const labs = toReview.filter((d) => d.category === "lab");
  const vitals = toReview.filter((d) => d.category === "vitals");
  if (toReview.length) {
    const parts = [labs.length && plural(labs.length, "provsvar utanför referens", "provsvar utanför referens"),
      vitals.length && plural(vitals.length, "avvikande trend", "avvikande trender")].filter(Boolean);
    lines.push(`${parts.join(" och ")} väntar på din granskning, hos ${list(toReview.map((d) => d.display_name))}.`);
    focus.push({ target: "review", label: "Att granska", count: toReview.length, tone: high.length ? "alert" : "warn" });
  }

  const drafts = data.unsigned?.length ?? 0;
  if (drafts) {
    lines.push(`${plural(drafts, "utkast är", "utkast är")} inte publicerade till patientappen än.`);
    focus.push({ target: "drafts", label: "Ej publicerade", count: drafts, tone: "warn" });
  }

  const due = followupsDue(data.followups, now);
  if (due.length) {
    const late = due.filter((f) => f.overdue).length;
    lines.push(`${plural(due.length, "patient behöver", "patienter behöver")} boka sin månadsuppföljning${late ? `, ${late} är försenade` : ""}.`);
    focus.push({ target: "followups", label: "Uppföljning", count: due.length, tone: late ? "warn" : "calm" });
  }

  const messages = data.counts.messages ?? 0;
  if (messages) {
    lines.push(`${plural(messages, "patient väntar", "patienter väntar")} på svar i inkorgen.`);
    focus.push({ target: "messages", label: "Meddelanden", count: messages, tone: "warn" });
  }
  if (data.counts.consultations) {
    lines.push(`En kollega väntar på ditt svar på ${plural(data.counts.consultations, "konsultation", "konsultationer")}.`);
    focus.push({ target: "consultations", label: "Konsultationer", count: data.counts.consultations, tone: "warn" });
  }
  const syncs = deviations.filter((d) => d.category === "sync").length;
  if (syncs) focus.push({ target: "deviations", label: "Ingen datasynk", count: syncs, tone: "calm" });

  if (!lines.length) lines.push("Allt är lugnt. Inga avvikelser, utkast eller meddelanden väntar på dig.");
  else if (lines.length === 1 && meetings.length) lines.push("Inget annat väntar på dig just nu.");

  const tasks = toReview.length + drafts + messages + data.counts.consultations + due.length;
  const mood: Mood = high.length ? "alert" : tasks >= 5 ? "busy" : "calm";
  return { greeting, mood, lines, focus };
}

/** A colleague in the clinic directory ("Kollegor"). */
export type Colleague = {
  id: string;
  organization: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  self: boolean;
  /** Doctors only: patients assigned to them. */
  patients: number | null;
  /** Doctors only: colleagues in their team. */
  teamSize: number | null;
  /** Everyone but doctors: the doctor whose team they belong to. */
  team: string | null;
};

/** A doctor's list is full at 100 patients. */
export const FULL_LIST = 100;

/** Green below 50 patients, yellow from 50, red at 100 or more. */
export function workloadLevel(patients: number): "ok" | "busy" | "full" {
  return patients >= FULL_LIST ? "full" : patients >= 50 ? "busy" : "ok";
}

/** Share of a full list, 0–1. */
export function workloadShare(patients: number) {
  return Math.min(1, Math.max(0, patients / FULL_LIST));
}

const roleOrder = ["doctor", "nurse", "psychologist", "secretary"];

export type ColleagueSort = "role" | "name" | "workload";

/** Default: doctors first, then the other roles, by name. Workload: busiest doctors first, others after by name. */
export function sortColleagues(list: Colleague[], by: ColleagueSort) {
  const rank = (c: Colleague) => (roleOrder.includes(c.role) ? roleOrder.indexOf(c.role) : roleOrder.length);
  const byName = (a: Colleague, b: Colleague) => a.name.localeCompare(b.name, "sv");
  return [...list].sort((a, b) => {
    if (by === "name") return byName(a, b);
    if (by === "workload") {
      const pa = a.patients ?? -1, pb = b.patients ?? -1;
      return pb - pa || byName(a, b);
    }
    return rank(a) - rank(b) || byName(a, b);
  });
}

/** Matches name, e-mail, team and role, ignoring case and accents. */
export function matchesColleague(c: Colleague, query: string, roleName: string) {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const q = fold(query.trim());
  if (!q) return true;
  return [c.name, c.email ?? "", c.team ?? "", roleName].some((field) => fold(field).includes(q));
}

/** A dialable link: "+46 70-123 45 67" becomes "tel:+46701234567". */
export function telHref(phone: string) {
  return "tel:" + phone.replace(/[^\d+]/g, "");
}

/** Accepts what the database accepts: digits with spaces, dashes and brackets, optionally a leading plus. */
export function validPhone(phone: string) {
  return /^\+?[0-9][0-9 ()-]{5,22}$/.test(phone.trim());
}

export function initials(name: string) {
  const parts = name.replace(/^(dr|dr\.)\s+/i, "").split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase();
}

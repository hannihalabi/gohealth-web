import type { Member } from "./administration";
import type { OverviewData } from "./overview";

export type OrganizationDirectory = {
  members: Member[];
  pending: number;
  checkedAt: string;
};

export class DirectoryError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Read both scoped, paginated directories instead of the older 500-row snapshot.
// No result is returned until every requested page has succeeded.
export async function readOrganizationDirectory(
  organizationId: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<OrganizationDirectory> {
  async function readPortal(memberPortal: "admin" | "clinician") {
    const members: Member[] = [];
    let offset = 0;
    let first: OverviewData | null = null;
    while (true) {
      const response = await request("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "overview", organizationId, memberPortal, memberOffset: offset }),
        cache: "no-store",
        signal,
      });
      const page: OverviewData & { error?: string } = await response.json();
      if (!response.ok) throw new DirectoryError(response.status, page.error || "Organisationskartan kunde inte hämtas.");
      if (!Array.isArray(page.members) || !Number.isInteger(page.memberTotal) || page.memberTotal < 0 ||
        !Number.isInteger(page.memberLimit) || page.memberLimit <= 0 || page.memberOffset !== offset ||
        page.memberPortal !== memberPortal) {
        throw new Error("Personaluppgifterna kunde inte läsas. Uppdatera kartan.");
      }
      first ??= page;
      members.push(...page.members);
      if (offset + page.members.length >= page.memberTotal) break;
      if (!page.members.length) throw new Error("Personallistan ändrades under hämtningen. Uppdatera kartan.");
      offset += page.memberLimit;
    }
    return { members, first: first! };
  }
  const [administration, clinical] = await Promise.all([readPortal("admin"), readPortal("clinician")]);
  // A person may hold both kinds of access. Preserve both roles in the chart.
  const unique = new Map([...administration.members, ...clinical.members].map((m) => [m.user_id + ":" + m.role, m]));
  return {
    members: [...unique.values()].sort((a, b) => a.display_name.localeCompare(b.display_name, "sv")),
    pending: administration.first.counts.pending,
    checkedAt: administration.first.checkedAt,
  };
}

export function groupCareTeams(members: Member[]) {
  const ordered = (items: Member[]) => [...items].sort((a, b) => Number(b.active) - Number(a.active) || a.display_name.localeCompare(b.display_name, "sv"));
  const doctors = ordered(members.filter((m) => m.role === "doctor"));
  // Nurses, psychologists and medical secretaries all work in a doctor's team.
  const team = ordered(members.filter((m) => m.role === "nurse" || m.role === "psychologist" || m.role === "secretary"));
  const validDoctorIds = new Set(doctors.filter((m) => m.active).map((m) => m.user_id));
  return {
    administrators: ordered(members.filter((m) => m.role === "admin")),
    teams: doctors.map((doctor) => ({ doctor, nurses: team.filter((n) => n.active && doctor.active && n.doctor_id === doctor.user_id) })),
    unassigned: team.filter((n) => !n.active || !n.doctor_id || !validDoctorIds.has(n.doctor_id)),
  };
}

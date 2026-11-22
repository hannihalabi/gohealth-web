import { z } from "zod";
import type { Member, StaffRole } from "./administration";

export const overviewRequest = z.object({
  action: z.literal("overview"),
  organizationId: z.uuid(),
  memberPortal: z.enum(["clinician", "admin"]).default("clinician"),
  memberOffset: z.number().int().min(0).max(100000).default(0),
}).strict();

export type Integration = {
  id: string;
  name: string;
  kind: "admin" | "clinician" | "app" | "website" | "service";
  description: string;
  connected: boolean;
  updated_at: string;
  last_activity_at?: string | null;
};
export type OverviewData = {
  integrations: Integration[];
  checkedAt: string;
  members: Member[];
  memberTotal: number;
  memberOffset: number;
  memberLimit: number;
  memberPortal: "clinician" | "admin";
  counts: { admin: number; clinician: number; pending: number };
};

// Positions derive from the registry, so added/removed integrations need no JSX edits.
export function integrationPositions(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const angle = (-135 + index * (360 / count)) * Math.PI / 180;
    return { x: 50 + Math.cos(angle) * 38, y: 50 + Math.sin(angle) * 34 };
  });
}

export function demoOverview(
  members: Member[],
  pending: number,
  memberPortal: "clinician" | "admin",
  memberOffset = 0,
): OverviewData {
  const checkedAt = new Date().toISOString();
  const kinds = ["admin", "clinician", "website", "app"] as const;
  const names = ["Admin-portalen", "Clinician-portalen", "Hemläkare.se", "GoHealth iOS"];
  const descriptions = [
    "Personal, behörigheter och patienttilldelning.",
    "Vårdteamets arbetsyta för patientuppföljning.",
    "Publik webbplats. Ännu ingen databasanslutning.",
    "Patientappen med delade hälsodata och kliniska resultat.",
  ];
  const belongs = (role: StaffRole) => memberPortal === "admin" ? role === "admin" : role !== "admin";
  const visible = members.filter((m) => belongs(m.role));
  return {
    integrations: kinds.map((kind, i) => ({
      id: kind, kind, name: names[i], description: descriptions[i],
      connected: kind !== "website", updated_at: checkedAt,
      last_activity_at: kind === "website" ? null : new Date(Date.now() - (i + 1) * 300000).toISOString(),
    })),
    checkedAt, members: visible.slice(memberOffset, memberOffset + 50),
    memberTotal: visible.length, memberOffset, memberLimit: 50, memberPortal,
    counts: {
      admin: members.filter((m) => m.role === "admin" && m.active).length,
      clinician: members.filter((m) => m.role !== "admin" && m.active).length,
      pending,
    },
  };
}

// Relative Swedish label for the last recorded activity; no activity is stated plainly.
export function activityLabel(at: string | null | undefined, now = Date.now()) {
  if (!at) return "Ingen aktivitet ännu";
  const minutes = Math.max(0, Math.floor((now - new Date(at).getTime()) / 60000));
  if (minutes < 1) return "Aktiv just nu";
  if (minutes < 60) return `Senast aktiv för ${minutes} min sedan`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Senast aktiv för ${hours} tim sedan`;
  const days = Math.floor(hours / 24);
  return `Senast aktiv för ${days} ${days === 1 ? "dag" : "dagar"} sedan`;
}

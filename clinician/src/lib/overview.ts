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

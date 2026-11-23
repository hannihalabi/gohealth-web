import { z } from "zod";
export const roleNames = {
  doctor: "Läkare",
  nurse: "Sjuksköterska",
  psychologist: "Psykolog",
  secretary: "Medicinsk sekreterare",
  admin: "Administratör",
} as const;
/** Clinical roles. Only doctors publish and see every patient in the clinic; the others work with assigned patients. */
export const clinicalRoles = ["doctor", "nurse", "psychologist", "secretary"] as const;
export type StaffRole = keyof typeof roleNames;
export type PortalSession = {
  staff: boolean;
  access?: boolean;
  clinical?: boolean;
  admin?: boolean;
  aal: string;
  mfa_required?: boolean;
  password_session?: boolean;
  name: string;
  role: string;
  userId?: string;
  organizations?: { id: string; name: string }[];
};
export function portalSessionReady(session: Pick<PortalSession, "aal" | "mfa_required" | "password_session">) {
  return session.aal === "aal2" ||
    (session.aal === "aal1" && session.mfa_required === false && session.password_session === true);
}
const name = (max = 120) => z.string().trim().min(1).max(max);
const organization = { organizationId: z.uuid() };
const email = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
export const administrationCommand = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("careTeam"),
    ...organization,
    nurseId: z.uuid(),
    doctorId: z.uuid().nullable(),
    revision: z.number().int().min(0),
  }).strict(),
  z
    .object({
      action: z.literal("snapshot"),
      ...organization,
      query: z.string().trim().max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal("invite"),
      ...organization,
      name: name(),
      email,
      role: z.enum(["doctor", "nurse", "psychologist", "secretary", "admin"]),
      identityAttested: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancelInvitation"),
      ...organization,
      id: z.uuid(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("member"),
      ...organization,
      userId: z.uuid(),
      name: name(),
      role: z.enum(["doctor", "nurse", "psychologist", "secretary", "admin"]),
      memberType: z.enum(["clinical", "admin"]),
      active: z.boolean(),
      identityAttested: z.boolean(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("patient"),
      ...organization,
      name: name(160),
      email,
      identity: z.string().trim().min(3).max(40),
      identityAttested: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("assignment"),
      ...organization,
      patientId: z.uuid(),
      userId: z.uuid(),
      active: z.boolean(),
      revision: z.number().int().min(0),
    })
    .strict(),
]);
export type AdminCommand = z.infer<typeof administrationCommand>;
export type Member = {
  patient_count?: number | null;
  doctor_id?: string | null;
  team_revision?: number;
  user_id: string;
  display_name: string;
  role: StaffRole;
  active: boolean;
  revision: number;
  email: string;
};
export type Invitation = {
  id: string;
  display_name: string;
  role: StaffRole;
  email: string;
  expires_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  revision: number;
};
export type AdminPatient = {
  id: string;
  display_name: string;
  identity_label: string;
  identity_verified: boolean;
  active: boolean;
  revision: number;
};
export type Assignment = {
  patient_id: string;
  clinician_id: string;
  active: boolean;
  revision: number;
};
export type AdministrationData = {
  members: Member[];
  invitations: Invitation[];
  patients: AdminPatient[];
  assignments: Assignment[];
  audit: {
    action: string;
    created_at: string;
    actor_id?: string | null;
    subject_id?: string | null;
    details?: { role?: StaffRole; active?: boolean; clinicianId?: string };
  }[];
};
export type PendingAccess = {
  id: string;
  name: string;
  role: StaffRole;
  organization: string;
  expiresAt: string;
};
export function invitationState(invite: Invitation, now = Date.now()) {
  return invite.accepted_at
    ? "Aktiverad"
    : invite.cancelled_at
      ? "Återkallad"
      : Date.parse(invite.expires_at) <= now
        ? "Utgången"
        : "Väntar på aktivering";
}

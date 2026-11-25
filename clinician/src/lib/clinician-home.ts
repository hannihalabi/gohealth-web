export type HomeAnnouncement = { id: string; title: string; body: string; created_at: string; author: string; expires_at?: string | null; active?: boolean };
export type HomeConsultation = {
  id: string;
  patient_id: string;
  display_name: string;
  direction: "in" | "out";
  status: "open" | "answered" | "closed";
  message: string;
  reply: string | null;
  created_at: string;
  replied_at: string | null;
  from_name: string | null;
  to_name: string | null;
  record: { id: string; kind: string; title: string | null } | null;
};
export type DeviationData = {
  recent?: number; base?: number; unit?: string | null; direction?: "up" | "down" | "high" | "low";
  name?: string; value?: number; low?: number | null; high?: number | null;
};
export type HomeDeviation = {
  patient_id: string;
  display_name: string;
  rule: string;
  category?: "vitals" | "lab" | "sync";
  severity: "high" | "warn" | "info";
  title: string;
  detail: string;
  at: string | null;
  key?: string;
  record_id?: string | null;
  data?: DeviationData;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
};
export type HomeMeeting = { id: string; patient_id: string; display_name: string; visit_type: "video" | "phone" | "clinic"; starts_at: string; ends_at: string };
export type HomeFollowup = {
  patient_id: string; display_name: string; last_at: string | null; next_at: string | null;
  next_visit_type: "video" | "phone" | "clinic" | null; due_on: string | null;
};
export type HomePatientMessage = { patient_id: string; display_name: string; body: string; created_at: string; waiting: number };
export type HomeUnsigned = { id: string; patient_id: string; display_name: string; kind: string; title: string | null; created_at: string };
export type HomeData = {
  counts: { assigned: number; clinic: number; unsigned: number; consultations: number; messages?: number; review?: number };
  role?: string;
  agenda?: HomeMeeting[];
  followups?: HomeFollowup[];
  unsigned: HomeUnsigned[];
  announcements: HomeAnnouncement[];
  consultations: HomeConsultation[];
  deviations: HomeDeviation[];
  /** Patient messages waiting for the care team. */
  messages?: HomePatientMessage[];
};
export type Colleague = { user_id: string; display_name: string };

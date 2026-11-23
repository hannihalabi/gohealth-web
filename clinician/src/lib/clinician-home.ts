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
export type HomeDeviation = {
  patient_id: string;
  display_name: string;
  rule: string;
  severity: "high" | "warn" | "info";
  title: string;
  detail: string;
  at: string | null;
};
export type HomeUnsigned = { id: string; patient_id: string; display_name: string; kind: string; title: string | null; created_at: string };
export type HomeData = {
  counts: { assigned: number; clinic: number; unsigned: number; consultations: number };
  unsigned: HomeUnsigned[];
  announcements: HomeAnnouncement[];
  consultations: HomeConsultation[];
  deviations: HomeDeviation[];
};
export type Colleague = { user_id: string; display_name: string };

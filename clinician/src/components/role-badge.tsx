import { roleNames, type StaffRole } from "@/lib/administration";
import "./role-badge.css";

/** Role as a Swedish healthcare name badge: Läkare red, Sjuksköterska blue, Psykolog orange, Medicinsk sekreterare purple. */
export function RoleBadge({ role, small = false }: { role: string; small?: boolean }) {
  const known = role in roleNames;
  return (
    <span className={`role-badge role-${known ? role : "other"}${small ? " is-small" : ""}`}>
      {known ? roleNames[role as StaffRole] : "Vårdpersonal"}
    </span>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Building2, Check, Clock3, HeartPulse, Network, RefreshCw, ShieldCheck, Stethoscope, Users } from "lucide-react";
import { invitationState, type AdministrationData, type Member, type StaffRole } from "@/lib/administration";
import { DirectoryError, readOrganizationDirectory, type OrganizationDirectory } from "@/lib/organization-directory";
import "./organization-chart.css";

const groups = [
  { role: "admin", name: "Administration", singular: "administratör", icon: ShieldCheck },
  { role: "doctor", name: "Läkare", singular: "läkare", icon: Stethoscope },
  { role: "nurse", name: "Sjuksköterskor", singular: "sjuksköterska", icon: HeartPulse },
] as const;

export function OrganizationChart({ organizationId, organizationName, demo, source, currentUserId, editing, onMember }: {
  organizationId: string;
  organizationName: string;
  demo: boolean;
  source: AdministrationData | null;
  currentUserId?: string;
  editing: boolean;
  onMember: (member: Member) => void;
}) {
  const [directory, setDirectory] = useState<OrganizationDirectory | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [visible, setVisible] = useState<Record<StaffRole, number>>({ admin: 3, doctor: 3, nurse: 3 });
  const latest = useRef(source);
  latest.current = source;

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    async function read() {
      if (disposed || inFlight) return;
      inFlight = true;
      setBusy(true);
      try {
        let next: OrganizationDirectory;
        if (demo) {
          const value = latest.current;
          if (!value) return;
          next = {
            members: value.members,
            pending: value.invitations.filter((i) => invitationState(i) === "Väntar på aktivering").length,
            checkedAt: new Date().toISOString(),
          };
        } else {
          next = await readOrganizationDirectory(organizationId, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
        }
        if (!disposed) {
          setDirectory(next);
          setError("");
        }
      } catch (e) {
        if (!disposed) {
          if (e instanceof DirectoryError && [401, 403].includes(e.status)) setDirectory(null);
          setError(e instanceof Error ? e.message : "Organisationskartan kunde inte hämtas.");
        }
      } finally {
        inFlight = false;
        if (!disposed) setBusy(false);
      }
    }
    void read();
    const resume = () => { if (!document.hidden) void read(); };
    const timer = window.setInterval(resume, 30000);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [organizationId, demo, source, refresh]);

  return <OrganizationChartView
    organizationName={organizationName} directory={directory} busy={busy} error={error}
    demo={demo} currentUserId={currentUserId} editing={editing} visible={visible}
    onMore={(role) => setVisible((value) => ({ ...value, [role]: value[role] + 20 }))}
    onRefresh={() => setRefresh((value) => value + 1)} onMember={onMember}
  />;
}

export function OrganizationChartView({ organizationName, directory, busy, error, demo, currentUserId, editing, visible, onMore, onRefresh, onMember }: {
  organizationName: string;
  directory: OrganizationDirectory | null;
  busy: boolean;
  error: string;
  demo: boolean;
  currentUserId?: string;
  editing: boolean;
  visible: Record<StaffRole, number>;
  onMore: (role: StaffRole) => void;
  onRefresh: () => void;
  onMember: (member: Member) => void;
}) {
  const members = directory?.members ?? [];
  const active = members.filter((m) => m.active);
  const people = new Set(active.map((m) => m.user_id)).size;
  return <section className="team-map" aria-labelledby="team-map-title" aria-busy={busy}>
    <header className="team-map-heading">
      <div><span className="team-map-heading-icon"><Network size={20} /></span><div><h2 id="team-map-title">Organisationskarta</h2><p>Mottagningen och människorna i ditt team, grupperade efter roll.</p></div></div>
      <button type="button" className="button secondary" disabled={busy} onClick={onRefresh}><RefreshCw size={16} />Uppdatera</button>
    </header>
    {error && <div className="team-map-error" role="alert">{error} {directory ? "Kartan visar senast hämtade uppgifter och kan vara inaktuell." : "Ingen aktuell organisationskarta kan visas."}</div>}
    {!directory ? <div className="team-map-loading" role="status"><Users size={28}/><p>{busy ? "Hämtar ditt team…" : "Personaluppgifterna är inte tillgängliga."}</p></div> : <>
      <div className="team-map-canvas">
        <div className="team-map-root">
          <span className="team-map-root-icon"><Building2 size={26}/></span>
          <span className="team-map-root-label">MOTTAGNING</span>
          <h3>{organizationName}</h3>
          <span>{people} {people === 1 ? "person" : "personer"} i det aktiva teamet</span>
        </div>
        <div className="team-map-branches">
          {groups.map(({ role, name, singular, icon: Icon }) => {
            const staff = members.filter((m) => m.role === role).sort((a, b) => Number(b.active) - Number(a.active) || a.display_name.localeCompare(b.display_name, "sv"));
            const activeCount = staff.filter((m) => m.active).length;
            return <section className="team-map-branch" key={role} aria-label={name}>
              <div className="team-map-role"><span><Icon size={19}/></span><div><h3>{name}</h3><p>{activeCount} {activeCount === 1 ? "aktiv" : "aktiva"} · {staff.length} totalt</p></div></div>
              {staff.length ? <ul className="team-map-people">{staff.slice(0, visible[role]).map((member) => {
                const ownClinical = member.user_id === currentUserId && member.role !== "admin";
                return <li key={member.user_id + member.role}><button type="button" className={"team-map-person " + (!member.active ? "is-inactive" : "")}
                  disabled={editing || busy || !!error || ownClinical} onClick={() => onMember(member)}
                  title={ownClinical ? "Din egen kliniska behörighet hanteras av en annan administratör." : `Hantera ${member.display_name}`}>
                  <span className="team-map-avatar">{member.display_name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("")}</span>
                  <span className="team-map-person-text"><strong>{member.display_name}</strong><span>{member.email}</span><small className={"team-map-status " + (!member.active ? "is-inactive" : "")}>
                    {member.active && <Check size={12}/>} {member.active ? "Aktiv behörighet" : "Inaktiv behörighet"}
                  </small></span>
                </button></li>;
              })}</ul> : <div className="team-map-empty">Ingen {singular} tillagd ännu.</div>}
              {staff.length > visible[role] && <button type="button" className="team-map-more" onClick={() => onMore(role)}>Visa fler ({staff.length - visible[role]})</button>}
            </section>;
          })}
        </div>
      </div>
      <footer className="team-map-footer">
        <div><span><ShieldCheck size={15}/>{active.length} {active.length === 1 ? "aktiv behörighet" : "aktiva behörigheter"}</span><span><Users size={15}/>{members.length - active.length} {members.length - active.length === 1 ? "inaktiv" : "inaktiva"}</span><span><Clock3 size={15}/>{directory.pending} väntar på aktivering</span></div>
        <p>{error ? "Senast hämtat" : demo ? "Demodata" : "Uppdaterad"} {new Date(directory.checkedAt).toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" })} · uppdateras automatiskt</p>
      </footer>
    </>}
  </section>;
}

"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Building2, HeartPulse, Network, RefreshCw, ShieldCheck, Stethoscope, Users, X } from "lucide-react";
import { invitationState, type AdminCommand, type AdministrationData, type Member } from "@/lib/administration";
import { RoleBadge } from "@/components/role-badge";
import { DirectoryError, groupCareTeams, readOrganizationDirectory, type OrganizationDirectory } from "@/lib/organization-directory";
import "./organization-chart.css";

type CareTeamCommand = Extract<AdminCommand, { action: "careTeam" }>;
export function OrganizationChart({ organizationId, organizationName, demo, source, currentUserId, editing, onMember, onCareTeam }: {
  organizationId: string;
  organizationName: string;
  demo: boolean;
  source: AdministrationData | null;
  currentUserId?: string;
  editing: boolean;
  onMember: (member: Member) => void;
  onCareTeam: (command: CareTeamCommand) => Promise<void>;
}) {
  const [directory, setDirectory] = useState<OrganizationDirectory | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [visible, setVisible] = useState<Record<string, number>>({ admin: 3, doctor: 6, unassigned: 3 });
  const [teamNurse, setTeamNurse] = useState<Member | null>(null);
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
            members: value.members.map((member) => ({ ...member,
              patient_count: member.role === "admin" ? null : member.active
                ? new Set(value.assignments.filter((a) => a.active && a.clinician_id === member.user_id).map((a) => a.patient_id)).size : 0,
              doctor_id: member.doctor_id ?? null, team_revision: member.team_revision ?? 0,
            })),
            pending: value.invitations.filter((i) => invitationState(i) === "Väntar på aktivering").length,
            checkedAt: new Date().toISOString(),
          };
        } else {
          next = await readOrganizationDirectory(organizationId, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
        }
        if (!disposed) { setDirectory(next); setError(""); }
      } catch (e) {
        if (!disposed) {
          if (e instanceof DirectoryError && [401, 403].includes(e.status)) { setDirectory(null); setTeamNurse(null); }
          setError(e instanceof Error ? e.message : "Teamet kunde inte hämtas.");
        }
      } finally { inFlight = false; if (!disposed) setBusy(false); }
    }
    void read();
    const resume = () => { if (!document.hidden) void read(); };
    const timer = window.setInterval(resume, 30000);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true; controller.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", resume); window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [organizationId, demo, source, refresh]);

  return <>
    <OrganizationChartView organizationName={organizationName} directory={directory} busy={busy} error={error}
      currentUserId={currentUserId} editing={editing} visible={visible}
      onMore={(key) => setVisible((value) => ({ ...value, [key]: (value[key] ?? 3) + 20 }))}
      onRefresh={() => setRefresh((value) => value + 1)} onMember={onMember} onTeam={setTeamNurse} />
    {teamNurse && directory && <TeamEditor key={teamNurse.user_id} nurse={teamNurse}
      doctors={directory.members.filter((m) => m.role === "doctor" && m.active)} busy={editing}
      onClose={() => { if (!editing) setTeamNurse(null); }}
      onSave={async (doctorId) => {
        await onCareTeam({ action: "careTeam", organizationId, nurseId: teamNurse.user_id,
          doctorId, revision: teamNurse.team_revision ?? 0 });
        setTeamNurse(null); setRefresh((value) => value + 1);
      }} />}
  </>;
}

function PersonCard({ member, disabled, currentUserId, onMember, onTeam }: {
  member: Member; disabled: boolean; currentUserId?: string;
  onMember: (member: Member) => void; onTeam: (member: Member) => void;
}) {
  const ownClinical = member.user_id === currentUserId && member.role !== "admin";
  const clinical = member.role !== "admin";
  const count = member.patient_count;
  return <div className={"team-person-row " + (!member.active ? "is-inactive" : "")}>
    <button type="button" className="team-person-main" disabled={disabled || ownClinical}
      onClick={() => onMember(member)} title={member.email} aria-label={`Hantera ${member.display_name}`}>
      <span className="team-map-avatar">{member.display_name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("")}</span>
      <span className="team-person-name"><strong>{member.display_name}</strong>
        {(member.role === "psychologist" || member.role === "secretary") && <RoleBadge role={member.role} small />}
        {!member.active && <small>Inaktiv</small>}
      </span>
      {member.active && <span className="team-person-active" role="img" aria-label="Aktiv" />}
    </button>
    {clinical && <div className="team-patient-count" title="Aktiva patienttilldelningar" aria-label={`${count ?? "Okänt antal"} patienter`}>
      <strong>{typeof count === "number" ? count : "—"}</strong><span>{count === 1 ? "patient" : "patienter"}</span>
    </div>}
    {member.role === "nurse" && member.active && <button type="button" className="team-link-button"
      disabled={disabled} onClick={() => onTeam(member)} aria-label={`Välj läkare för ${member.display_name}`}
      title="Välj läkare"><Network size={16}/></button>}
  </div>;
}

export function OrganizationChartView({ organizationName, directory, busy, error, currentUserId, editing, visible, onMore, onRefresh, onMember, onTeam }: {
  organizationName: string; directory: OrganizationDirectory | null; busy: boolean; error: string;
  currentUserId?: string; editing: boolean; visible: Record<string, number>;
  onMore: (key: string) => void; onRefresh: () => void;
  onMember: (member: Member) => void; onTeam: (member: Member) => void;
}) {
  const members = directory?.members ?? [];
  const { administrators, teams, unassigned, others } = groupCareTeams(members);
  const people = new Set(members.filter((m) => m.active).map((m) => m.user_id)).size;
  const locked = editing || busy || !!error;
  const limit = (key: string) => visible[key] ?? 3;
  const card = (member: Member) => <PersonCard member={member} disabled={locked} currentUserId={currentUserId} onMember={onMember} onTeam={onTeam}/>;
  const more = (key: string, total: number) => total > limit(key) && <button type="button" className="team-map-more" onClick={() => onMore(key)}>Visa fler ({total - limit(key)})</button>;
  return <section className="team-map" aria-label="Organisationskarta" aria-busy={busy}>
    <header className="team-map-heading"><h2>Organisation</h2><div>
      {!!directory?.pending && <span className="team-pending">{directory.pending} väntar på aktivering</span>}
      <button type="button" className="team-refresh" disabled={busy} onClick={onRefresh} aria-label="Uppdatera organisationskartan"
        title={directory ? `Uppdaterad ${new Date(directory.checkedAt).toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" })}` : "Uppdatera"}><RefreshCw size={17}/></button>
    </div></header>
    {error && <div className="team-map-error" role="alert">{error} {directory && "Kartan kan vara inaktuell."}</div>}
    {!directory ? <div className="team-map-loading" role="status"><Users size={28}/><p>{busy ? "Hämtar teamet…" : "Teamet kan inte visas."}</p></div> : <div className="team-map-canvas">
      <div className="team-map-root"><Building2 size={23}/><div><h3>{organizationName}</h3><span>{people} {people === 1 ? "person" : "personer"}</span></div></div>
      <div className="team-map-branches">
        <section className="team-map-branch" aria-label="Administration">
          <div className="team-map-role"><ShieldCheck size={19}/><h3>Administration</h3><span>{administrators.length}</span></div>
          <ul className="team-map-people">{administrators.slice(0, limit("admin")).map((member) => <li key={member.user_id}>{card(member)}</li>)}</ul>
          {more("admin", administrators.length)}
        </section>
        <section className="team-map-branch" aria-label="Vårdteam">
          <div className="team-map-role"><Stethoscope size={19}/><h3>Läkare</h3><span>{teams.length}</span></div>
          {teams.length ? <ul className="team-map-people">{teams.slice(0, limit("doctor")).map(({ doctor, nurses }) => <li key={doctor.user_id} className="team-doctor-team">
            {card(doctor)}
            <div className="team-nurses"><div className="team-nurses-label"><HeartPulse size={15}/><h4>Sjuksköterskor</h4><span>{nurses.length}</span></div>
              {!!nurses.length && <ul>{nurses.slice(0, limit(`nurses:${doctor.user_id}`)).map((nurse) => <li key={nurse.user_id}>{card(nurse)}</li>)}</ul>}
              {more(`nurses:${doctor.user_id}`, nurses.length)}
            </div>
          </li>)}</ul> : <div className="team-map-empty">Inga läkare</div>}
          {more("doctor", teams.length)}
          {!!unassigned.length && <div className="team-unassigned"><div className="team-nurses-label"><HeartPulse size={15}/><h4>Utan läkare</h4><span>{unassigned.length}</span></div>
            <ul>{unassigned.slice(0, limit("unassigned")).map((nurse) => <li key={nurse.user_id}>{card(nurse)}</li>)}</ul>
            {more("unassigned", unassigned.length)}
          </div>}
        </section>
        {!!others.length && <section className="team-map-branch" aria-label="Övrig vårdpersonal">
          <div className="team-map-role"><Users size={19}/><h3>Övrig vårdpersonal</h3><span>{others.length}</span></div>
          <ul className="team-map-people">{others.slice(0, limit("others")).map((member) => <li key={member.user_id}>{card(member)}</li>)}</ul>
          {more("others", others.length)}
        </section>}
      </div>
    </div>}
  </section>;
}

function TeamEditor({ nurse, doctors, busy, onClose, onSave }: {
  nurse: Member; doctors: Member[]; busy: boolean; onClose: () => void;
  onSave: (doctorId: string | null) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [doctorId, setDoctorId] = useState(nurse.doctor_id ?? "");
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError("");
    try { await onSave(doctorId || null); }
    catch (e) { setError(e instanceof Error ? e.message : "Teamet kunde inte sparas."); }
  }
  return <dialog ref={dialog} className="dialog" aria-label="Välj läkare" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading"><h2>Välj läkare</h2><button type="button" disabled={busy} aria-label="Stäng" onClick={onClose}><X size={20}/></button></div>
    <form onSubmit={submit}>
      <p className="dialog-patient">{nurse.display_name}</p>
      {error && <div className="alert error" role="alert">{error}</div>}
      <label>Läkare<select value={doctorId} disabled={busy} onChange={(e) => setDoctorId(e.target.value)}>
        <option value="">Ingen läkare</option>{doctors.map((doctor) => <option key={doctor.user_id} value={doctor.user_id}>{doctor.display_name}</option>)}
      </select></label>
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Avbryt</button><button className="button primary" disabled={busy}>Spara</button></div>
    </form>
  </dialog>;
}

"use client";
import type { PortalLinks } from "@/lib/portal-origins";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Heart,
  History,
  Network,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import {
  administrationCommand,
  invitationState,
  roleNames,
  type AdminCommand,
  type AdministrationData,
  type AdminPatient,
  type Invitation,
  type Member,
  type PortalSession,
  type StaffRole,
} from "@/lib/administration";
import { normalizeSearch } from "@/lib/model";
import { SystemOverview } from "@/components/overview/system-overview";
import { OrganizationChart } from "@/components/overview/organization-chart";
import "./administration.css";
const demoUser = "10000000-0000-4000-8000-000000000010";
function demoData(): AdministrationData {
  return {
    members: [
      {
        user_id: demoUser,
        display_name: "Sofia · testadministratör",
        email: "sofia@example.invalid",
        role: "admin",
        active: true,
        revision: 1,
      },
      {
        user_id: "10000000-0000-4000-8000-000000000011",
        display_name: "Amir · testläkare",
        email: "amir@example.invalid",
        role: "doctor",
        active: true,
        revision: 1,
      },
      {
        user_id: "10000000-0000-4000-8000-000000000012",
        display_name: "Elin · testsjuksköterska",
        email: "elin@example.invalid",
        role: "nurse",
        active: true,
        revision: 1,
      },
    ],
    invitations: [],
    patients: [
      {
        id: "40000000-0000-4000-8000-000000000010",
        display_name: "Alex Lind",
        identity_label: "TEST-0001",
        identity_verified: true,
        active: true,
        revision: 1,
      },
      {
        id: "40000000-0000-4000-8000-000000000011",
        display_name: "Kim Berg",
        identity_label: "TEST-0002",
        identity_verified: true,
        active: true,
        revision: 1,
      },
    ],
    assignments: [],
    audit: [
      { action: "administration.open", created_at: new Date().toISOString() },
    ],
  };
}
const auditNames: Record<string, string> = {
  "administration.open": "Administration öppnad",
  "administration.invite": "Personal tillagd för aktivering",
  "administration.cancelInvitation": "Väntande behörighet återkallad",
  "administration.member": "Personalbehörighet uppdaterad",
  "administration.patient": "Patientkonto kopplat till mottagningen",
  "administration.assignment": "Patienttilldelning uppdaterad",
  "administration.careTeam": "Teamkoppling uppdaterad",
  "invitation.accept": "Personalbehörighet aktiverad",
};
class AdministrationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function call(body: AdminCommand) {
  const r = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok)
    throw new AdministrationError(
      r.status,
      data.error || "Administrationen kunde inte nås.",
    );
  return data;
}
type Editor =
  | { kind: "invite" }
  | { kind: "member"; member: Member }
  | { kind: "patient" }
  | { kind: "assignment"; patient: AdminPatient }
  | { kind: "cancel"; invitation: Invitation };
export function AdministrationWorkspace({
  demo,
  session,
  onLogout,
  links,
}: {
  demo: boolean;
  session: PortalSession;
  onLogout: () => Promise<void>;
  links: PortalLinks;
}) {
  const organizations = session.organizations ?? [],
    [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? ""),
    [tab, setTab] = useState<"overview" | "staff" | "patients" | "history">("overview"),
    [data, setData] = useState<AdministrationData | null>(null),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [editor, setEditor] = useState<Editor | null>(null);
  const cache = useRef(demoData()),
    epoch = useRef(0),
    readId = useRef(0);
  async function load(search = query) {
    const current = epoch.current,
      request = ++readId.current;
    setBusy(true);
    try {
      const value = demo
        ? {
            ...cache.current,
            patients: cache.current.patients.filter(
              (p) =>
                !search ||
                p.identity_label === normalizeSearch(search) ||
                p.display_name.toLowerCase().includes(search.toLowerCase()),
            ),
          }
        : await call({ action: "snapshot", organizationId, query: search });
      if (current === epoch.current && request === readId.current) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (current === epoch.current && request === readId.current) {
        setData(null);
        setError((e as Error).message);
      }
    } finally {
      if (current === epoch.current && request === readId.current)
        setBusy(false);
    }
  }
  useEffect(() => {
    epoch.current++;
    if (session.admin && organizationId) void load("");
    return () => {
      epoch.current++;
      readId.current++;
    };
  }, [organizationId, session.admin]);
  async function perform(command: AdminCommand) {
    const parsed = administrationCommand.parse(command),
      current = epoch.current;
    setBusy(true);
    setError("");
    try {
      if (demo) {
        const value = structuredClone(cache.current),
          now = new Date().toISOString();
        if (parsed.action === "invite")
          value.invitations.unshift({
            id: crypto.randomUUID(),
            email: parsed.email,
            display_name: parsed.name,
            role: parsed.role,
            expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
            accepted_at: null,
            cancelled_at: null,
            revision: 1,
          });
        if (parsed.action === "member") {
          const m = value.members.find(
            (x) =>
              x.user_id === parsed.userId &&
              (x.role === "admin") === (parsed.memberType === "admin"),
          );
          if (!m || m.revision !== parsed.revision)
            throw new Error("Uppgifterna har ändrats. Uppdatera sidan.");
          if (
            m.user_id === demoUser &&
            (parsed.memberType !== "admin" ||
              parsed.role !== "admin" ||
              !parsed.active)
          )
            throw new Error("Din egen behörighet ändras inte här.");
          Object.assign(m, {
            display_name: parsed.name,
            role: parsed.role,
            active: parsed.active,
            revision: m.revision + 1,
          });
          for (const person of value.members) {
            if (person.doctor_id && ((person.user_id === m.user_id && (!m.active || m.role !== "nurse")) ||
              (person.doctor_id === m.user_id && (!m.active || m.role !== "doctor")))) {
              person.doctor_id = null;
              person.team_revision = (person.team_revision ?? 0) + 1;
            }
          }
          if (!m.active)
            value.assignments = value.assignments.map((a) =>
              a.clinician_id === m.user_id
                ? { ...a, active: false, revision: a.revision + 1 }
                : a,
            );
        }
        if (parsed.action === "careTeam") {
          const nurse = value.members.find((x) => x.user_id === parsed.nurseId && x.role === "nurse" && x.active);
          const doctor = value.members.find((x) => x.user_id === parsed.doctorId && x.role === "doctor" && x.active);
          if (!nurse || (parsed.doctorId && !doctor)) throw new Error("Välj en aktiv läkare och sjuksköterska.");
          if ((nurse.team_revision ?? 0) !== parsed.revision) throw new Error("Teamet har ändrats. Uppdatera kartan.");
          nurse.doctor_id = parsed.doctorId;
          nurse.team_revision = (nurse.team_revision ?? 0) + 1;
        }
        if (parsed.action === "cancelInvitation") {
          const inv = value.invitations.find((x) => x.id === parsed.id);
          if (!inv || inv.revision !== parsed.revision)
            throw new Error("Uppgifterna har ändrats.");
          inv.cancelled_at = now;
          inv.revision++;
        }
        if (parsed.action === "patient")
          value.patients.unshift({
            id: crypto.randomUUID(),
            display_name: parsed.name,
            identity_label: normalizeSearch(parsed.identity),
            identity_verified: true,
            active: true,
            revision: 1,
          });
        if (parsed.action === "assignment") {
          const a = value.assignments.find(
            (x) =>
              x.patient_id === parsed.patientId &&
              x.clinician_id === parsed.userId,
          );
          if (a) {
            if (a.revision !== parsed.revision)
              throw new Error("Tilldelningen har ändrats.");
            a.active = parsed.active;
            a.revision++;
          } else
            value.assignments.push({
              patient_id: parsed.patientId,
              clinician_id: parsed.userId,
              active: parsed.active,
              revision: 1,
            });
        }
        value.audit.unshift({
          action: "administration." + parsed.action,
          created_at: now,
        });
        cache.current = value;
      } else await call(parsed);
      if (current !== epoch.current) return;
      setEditor(null);
      setNotice(
        parsed.action === "invite"
          ? "Personen är tillagd för aktivering. Dela aktiveringsadressen och be personen använda exakt samma e-postadress. Inget mejl har skickats automatiskt."
          : "Ändringen är sparad.",
      );
      await load();
    } catch (e) {
      if (current === epoch.current) {
        if (e instanceof AdministrationError && [401, 403].includes(e.status))
          setData(null);
        setError((e as Error).message);
      }
      throw e;
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }
  if (!session.admin)
    return (
      <main className="activation-shell">
        <section className="activation-card">
          <ShieldCheck />
          <h1>Administratörsbehörighet krävs</h1>
          <p>Ditt konto har inte tillgång till administrationen.</p>
          <a href={links.clinical}>Till vårdportalen</a>
        </section>
      </main>
    );
  const active = data?.members.filter((m) => m.active).length ?? 0,
    waiting =
      data?.invitations.filter(
        (i) => invitationState(i) === "Väntar på aktivering",
      ).length ?? 0;
  return (
    <div className="workspace administration-workspace">
      <aside className="sidebar">
        <a className="brand" href={demo ? "/demo/admin" : links.administration}>
          <span className="brand-mark">
            <Heart />
          </span>
          <span>
            Go<span>Health</span>
            <i>.</i>
          </span>
        </a>
        <div className="workspace-label">ADMINISTRATION</div>
        <nav>
          {(
            [
              ["overview", "Översikt", Network],
              ["staff", "Personal", Users],
              ["patients", "Patienttilldelning", ClipboardList],
              ["history", "Historik", History],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              className={"nav-item " + (tab === id ? "selected" : "")}
              onClick={() => {
                setTab(id);
                setEditor(null);
                setNotice("");
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
          {session.clinical !== false && (
            <a className="nav-item" href={demo ? "/demo" : links.clinical}>
              <ArrowLeft size={18} />
              Till vårdportalen
            </a>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="staff">
            <div className="staff-avatar">
              <ShieldCheck size={20} />
            </div>
            <div>
              <strong>
                {data?.members.find(
                  (m) => m.user_id === session.userId && m.role === "admin",
                )?.display_name ?? session.name}
              </strong>
            </div>
            <button aria-label="Logga ut" onClick={() => void onLogout()}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        {demo && (
          <div className="demo-banner">
            <span>
              <strong>Demonstrationsmiljö</strong> · Syntetiska konton.
              Ändringar stannar i denna flik.
            </span>
            <a href="/">
              Till inloggningen <ArrowRight size={14} />
            </a>
          </div>
        )}
        <main className="content">
          <div className="admin-context">
            <label>
              Mottagning
              <select
                value={organizationId}
                disabled={busy}
                onChange={(e) => {
                  setData(null);
                  setEditor(null);
                  setQuery("");
                  setNotice("");
                  setOrganizationId(e.target.value);
                }}
              >
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="alert success" role="status">
              {notice}
            </div>
          )}
          {tab === "overview" ? <SystemOverview
            key={organizationId}
            organizationId={organizationId}
            demo={demo}
            administration={data}
            onStaff={() => setTab("staff")}
          /> : <>
          <div className="page-heading">
            <div>
              <h1>
                {tab === "staff"
                  ? "Ditt vårdteam"
                  : tab === "patients"
                    ? "Patienttilldelning"
                    : "Administrationshistorik"}
                <span>.</span>
              </h1>
            </div>
            {tab !== "history" && (
              <button
                className="button primary"
                disabled={busy || !organizationId}
                onClick={() =>
                  setEditor({ kind: tab === "staff" ? "invite" : "patient" })
                }
              >
                <Plus size={17} />
                {tab === "staff" ? "Lägg till personal" : "Koppla patientkonto"}
              </button>
            )}
          </div>
          {tab === "staff" ? <OrganizationChart
            key={organizationId}
            organizationId={organizationId}
            organizationName={organizations.find((o) => o.id === organizationId)?.name ?? "Mottagningen"}
            demo={demo}
            source={data}
            currentUserId={session.userId}
            editing={busy}
            onCareTeam={perform}
            onMember={(member) => setEditor({ kind: "member", member })}
          /> : <div className="stats">
            <section className="stat">
              <Users />
              <div>
                <span>Aktiva behörigheter</span>
                <strong>{active}</strong>
              </div>
            </section>
            <section className="stat">
              <ShieldCheck />
              <div>
                <span>Väntar på aktivering</span>
                <strong>{waiting}</strong>
              </div>
            </section>
            <section className="stat">
              <ClipboardList />
              <div>
                <span>Patienter i sökresultatet</span>
                <strong>{data?.patients.length ?? 0}</strong>
              </div>
            </section>
          </div>}
          {busy && !data && <p role="status">Hämtar administrationen…</p>}
          </>}
          {data && tab === "staff" && (
            <>
              <details className="admin-details">
              <summary>Personallista</summary>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Personal och behörigheter</h2>
                  </div>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Roll</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.members.map((m) => (
                        <tr key={m.user_id + m.role}>
                          <td>
                            <strong>{m.display_name}</strong>
                            <small className="admin-secondary">{m.email}</small>
                          </td>
                          <td>{roleNames[m.role]}</td>
                          <td>
                            <span className="pill">
                              {m.active ? "Aktiv" : "Inaktiv"}
                            </span>
                          </td>
                          <td>
                            <button
                              className="button secondary"
                              disabled={
                                busy ||
                                (m.user_id === session.userId &&
                                  m.role !== "admin")
                              }
                              title={
                                m.user_id === session.userId
                                  ? "Du kan ändra ditt namn. Din egen roll och aktivering är låsta."
                                  : undefined
                              }
                              onClick={() =>
                                setEditor({ kind: "member", member: m })
                              }
                            >
                              Hantera
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              </details>
              {waiting > 0 && <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Väntar på aktivering</h2>
                  </div>
                </div>
                {data.invitations.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Person</th>
                          <th>Roll</th>
                          <th>Status</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {data.invitations.filter((i) => invitationState(i) === "Väntar på aktivering").map((i) => (
                          <tr key={i.id}>
                            <td>
                              <strong>{i.display_name}</strong>
                              <small className="admin-secondary">
                                {i.email}
                              </small>
                            </td>
                            <td>{roleNames[i.role]}</td>
                            <td>{invitationState(i)}</td>
                            <td>
                              {invitationState(i) ===
                                "Väntar på aktivering" && (
                                <button
                                  className="button secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    setEditor({ kind: "cancel", invitation: i })
                                  }
                                >
                                  Återkalla
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty">
                    <h3>Inga väntande aktiveringar</h3>
                    <p>
                      Lägg till en person för att förbereda en ny behörighet.
                    </p>
                  </div>
                )}
                <div className="activation-address">
                  <label>
                    Adress att dela med personen
                    <input
                      readOnly
                      value={
                        typeof window === "undefined"
                          ? ""
                          : new URL(links.activation, window.location.origin).href
                      }
                      aria-label="Aktiveringsadress"
                    />
                  </label>
                </div>
              </section>}
            </>
          )}
          {data && tab === "patients" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Mottagningens patienter</h2>
                  <p>
                    Här visas identitet och tilldelning. Kliniska uppgifter
                    hanteras i vårdportalen.
                  </p>
                </div>
              </div>
              <form
                className="search"
                onSubmit={(e) => {
                  e.preventDefault();
                  void load();
                }}
              >
                <Search size={18} />
                <input
                  aria-label="Sök patient i administrationen"
                  placeholder="Sök namn eller exakt personnummer"
                  value={query}
                  maxLength={120}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button className="button secondary" disabled={busy}>
                  Sök
                </button>
              </form>
              {data.patients.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Patient</th>
                        <th>Identitet</th>
                        <th>Aktiva behandlare</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.patients.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <strong>{p.display_name}</strong>
                          </td>
                          <td>
                            {p.identity_label}
                            <small className="admin-secondary">
                              {p.identity_verified
                                ? "Verifierad kontokoppling"
                                : "Ej verifierad"}
                            </small>
                          </td>
                          <td>
                            {data.assignments
                              .filter((a) => a.patient_id === p.id && a.active)
                              .map(
                                (a) =>
                                  data.members.find(
                                    (m) =>
                                      m.user_id === a.clinician_id &&
                                      m.role !== "admin",
                                  )?.display_name,
                              )
                              .filter(Boolean)
                              .join(", ") || "Ingen tilldelad"}
                          </td>
                          <td>
                            <button
                              className="button secondary"
                              disabled={busy || !p.active}
                              onClick={() =>
                                setEditor({ kind: "assignment", patient: p })
                              }
                            >
                              Hantera tilldelning
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">
                  <h3>Inga patienter i sökresultatet</h3>
                  <p>
                    Koppla ett verifierat patientkonto eller ändra sökningen.
                  </p>
                </div>
              )}
            </section>
          )}
          {data && tab === "history" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Åtkomst och ändringar</h2>
                  <p>
                    De senaste 100 administrationshändelserna. Loggen innehåller
                    inga provsvar.
                  </p>
                </div>
              </div>
              {data.audit.map((a, i) => (
                <div className="history-row" key={i}>
                  <CheckCircle2 size={17} />
                  <strong>
                    {auditNames[a.action] ?? "Administrationsåtgärd"}
                    <small className="admin-secondary">
                      {data.members.find((m) => m.user_id === a.actor_id)
                        ?.display_name ??
                        (demo
                          ? "Testadministratör"
                          : "System / tidigare personal")}
                      {a.details?.role ? " · " + roleNames[a.details.role] : ""}
                      {typeof a.details?.active === "boolean"
                        ? a.details.active
                          ? " · Aktiv"
                          : " · Inaktiv"
                        : ""}
                    </small>
                  </strong>
                  <span>{new Date(a.created_at).toLocaleString("sv-SE")}</span>
                </div>
              ))}
            </section>
          )}
        </main>
      </div>
      {editor && data && (
        <AdminEditor
          key={editor.kind + ("member" in editor ? editor.member.user_id : "")}
          editor={editor}
          organizationId={organizationId}
          data={data}
          userId={session.userId}
          busy={busy}
          onClose={() => {
            if (!busy) setEditor(null);
          }}
          onSave={perform}
        />
      )}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  busy,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          type="button"
          disabled={busy}
          aria-label="Stäng"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function AdminEditor({
  editor,
  organizationId,
  data,
  userId,
  busy,
  onClose,
  onSave,
}: {
  editor: Editor;
  organizationId: string;
  data: AdministrationData;
  userId?: string;
  busy: boolean;
  onClose: () => void;
  onSave: (c: AdminCommand) => Promise<void>;
}) {
  const m = editor.kind === "member" ? editor.member : null;
  const [name, setName] = useState(m?.display_name ?? ""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<StaffRole>(m?.role ?? "doctor"),
    [active, setActive] = useState(m?.active ?? true),
    [identity, setIdentity] = useState(""),
    [attested, setAttested] = useState(false),
    [clinician, setClinician] = useState(""),
    [error, setError] = useState("");
  const title =
    editor.kind === "invite"
      ? "Lägg till personal"
      : editor.kind === "member"
        ? "Hantera personal"
        : editor.kind === "patient"
          ? "Koppla patientkonto"
          : editor.kind === "assignment"
            ? "Hantera patienttilldelning"
            : "Återkalla väntande behörighet";
  const existing =
    editor.kind === "assignment"
      ? data.assignments.find(
          (a) =>
            a.patient_id === editor.patient.id && a.clinician_id === clinician,
        )
      : undefined;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const common = { organizationId };
      const command: AdminCommand =
        editor.kind === "invite"
          ? {
              ...common,
              action: "invite",
              name,
              email,
              role,
              identityAttested: attested,
            }
          : editor.kind === "member"
            ? {
                ...common,
                action: "member",
                userId: editor.member.user_id,
                name,
                role,
                active,
                revision: editor.member.revision,
                memberType:
                  editor.member.role === "admin" ? "admin" : "clinical",
                identityAttested: attested,
              }
            : editor.kind === "patient"
              ? {
                  ...common,
                  action: "patient",
                  name,
                  email,
                  identity: normalizeSearch(identity),
                  identityAttested: attested as true,
                }
              : editor.kind === "assignment"
                ? {
                    ...common,
                    action: "assignment",
                    patientId: editor.patient.id,
                    userId: clinician,
                    active,
                    revision: existing?.revision ?? 0,
                  }
                : {
                    ...common,
                    action: "cancelInvitation",
                    id: editor.invitation.id,
                    revision: editor.invitation.revision,
                  };
      await onSave(command);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <form onSubmit={submit}>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {(editor.kind === "invite" ||
          editor.kind === "member" ||
          editor.kind === "patient") && (
          <label>
            Namn
            <input
              required
              maxLength={editor.kind === "patient" ? 160 : 120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {(editor.kind === "invite" || editor.kind === "patient") && (
          <label>
            E-postadress för GoHealth-kontot
            <input
              required
              type="email"
              maxLength={254}
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        )}
        {(editor.kind === "invite" || editor.kind === "member") && (
          <>
            <label>
              Roll
              <select
                value={role}
                disabled={m?.role === "admin"}
                onChange={(e) => setRole(e.target.value as StaffRole)}
              >
                {(editor.kind === "invite"
                  ? ["doctor", "nurse", "admin"]
                  : m?.role === "admin"
                    ? ["admin"]
                    : ["doctor", "nurse"]
                ).map((r) => (
                  <option key={r} value={r}>
                    {roleNames[r as StaffRole]}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {role === "admin"
                ? "Administratören kan hantera personal och patienttilldelningar. Rollen ger ingen automatisk klinisk läsbehörighet."
                : "Patientåtkomst kräver separat tilldelning. Bara läkare får publicera kliniska svar."}
            </p>
          </>
        )}
        {editor.kind === "member" && (
          <>
            <label className="check-label">
              <input
                type="checkbox"
                checked={active}
                disabled={m?.user_id === userId}
                onChange={(e) => setActive(e.target.checked)}
              />
              Behörigheten är aktiv
            </label>
            {!active && (
              <p className="admin-caution">
                {m?.role === "admin"
                  ? "Personen förlorar administrationen och väntande behörigheter som personen skapat återkallas."
                  : "Personens patienttilldelningar avslutas. Återaktivering återställer inte tilldelningarna."}
              </p>
            )}
          </>
        )}
        {editor.kind === "patient" && (
          <>
            <label>
              Verifierat personnummer eller identitetsuppgift
              <input
                required
                minLength={3}
                maxLength={40}
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
              />
            </label>
            <p className="muted">
              Patienten behöver ett befintligt konto med bekräftad e-postadress.
              Kontrollera identiteten och att kontot tillhör rätt person innan
              kopplingen skapas.
            </p>
          </>
        )}
        {(editor.kind === "invite" ||
          editor.kind === "patient" ||
          (editor.kind === "member" && role !== "admin")) && (
          <label className="check-label">
            <input
              required
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
            {editor.kind === "patient"
              ? "Jag har verifierat identiteten och kontokopplingen."
              : "Jag har kontrollerat personens identitet och att rollen är korrekt."}
          </label>
        )}
        {editor.kind === "assignment" && (
          <>
            <p className="dialog-patient">
              {editor.patient.display_name} · {editor.patient.identity_label}
            </p>
            <label>
              Behandlare
              <select
                required
                value={clinician}
                onChange={(e) => {
                  const id = e.target.value;
                  setClinician(id);
                  setActive(
                    data.assignments.find(
                      (a) =>
                        a.patient_id === editor.patient.id &&
                        a.clinician_id === id,
                    )?.active ?? true,
                  );
                }}
              >
                <option value="">Välj person</option>
                {data.members
                  .filter(
                    (x) =>
                      x.role !== "admin" && x.active && x.user_id !== userId,
                  )
                  .map((x) => (
                    <option key={x.user_id} value={x.user_id}>
                      {x.display_name} · {roleNames[x.role]}
                    </option>
                  ))}
              </select>
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Aktiv vårdrelation
            </label>
            <p className="admin-caution">
              {active
                ? "En aktiv tilldelning ger behandlaren åtkomst till patientens uppgifter i mottagningen. Kontrollera person och patient före bekräftelsen."
                : "Behandlarens åtkomst via denna vårdrelation avslutas vid nästa anrop."}
            </p>
          </>
        )}
        {editor.kind === "cancel" && (
          <>
            <p>
              {editor.invitation.display_name} · {editor.invitation.email}
            </p>
            <p>
              Den väntande behörigheten som{" "}
              {roleNames[editor.invitation.role].toLowerCase()} återkallas. Ett
              redan aktiverat konto ändras via personalens behörighetsrad.
            </p>
          </>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Avbryt
          </button>
          <button className="button primary" disabled={busy}>
            {editor.kind === "invite"
              ? "Spara för aktivering"
              : editor.kind === "cancel"
                ? "Återkalla behörigheten"
                : editor.kind === "assignment"
                  ? "Bekräfta tilldelningen"
                  : "Spara ändringen"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

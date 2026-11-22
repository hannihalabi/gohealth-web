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
  LayoutDashboard,
  UserPlus,
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
import { PatientsOverview } from "@/components/patients-overview";
import { SystemOverview } from "@/components/overview/system-overview";
import { OrganizationChart } from "@/components/overview/organization-chart";
import "./shell.css";
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
  "administration.signupapprove": "Patientregistrering godkänd",
  "administration.signupreject": "Patientregistrering avslagen",
  "administration.applicationhandled": "Ansökan hanterad",
  "administration.applicationdismissed": "Ansökan avfärdad",
};
function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "A"
  );
}
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
    [tab, setTab] = useState<"overview" | "newpatients" | "system" | "staff" | "patients" | "history">("overview"),
    [data, setData] = useState<AdministrationData | null>(null),
    [query, setQuery] = useState(""),
    [showAll, setShowAll] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [editor, setEditor] = useState<Editor | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    const close = (e: Event) => {
      const menu = document.querySelector<HTMLDetailsElement>(".admin-user");
      if (menu?.open && (e.type === "keydown" || !menu.contains(e.target as Node)))
        if (e.type !== "keydown" || (e as KeyboardEvent).key === "Escape") menu.open = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", close);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", close);
      window.removeEventListener("click", close);
    };
  }, []);
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
  const adminName =
    data?.members.find(
      (m) => m.user_id === session.userId && m.role === "admin",
    )?.display_name ?? session.name;
  return (
    <div className="workspace administration-workspace">
      <header className="admin-topbar">
        <a className="admin-brand" href={demo ? "/demo/admin" : links.administration}>
          <span className="brand-mark">
            <Heart size={18} />
          </span>
          <span>
            Go<span>Health</span>
            <i>.</i>
          </span>
        </a>
        <span className="admin-crumb-sep">/</span>
        {organizations.length > 1 ? (
          <select
            className="admin-org"
            aria-label="Mottagning"
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
        ) : (
          <span className="admin-org">
            {organizations[0]?.name ?? "Mottagning"}
          </span>
        )}
        <span className="admin-pill">Admin</span>
        <form
          className="admin-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setTab("patients");
            setShowAll(false);
            setEditor(null);
            setNotice("");
            void load(query);
          }}
        >
          <Search size={16} />
          <input
            ref={searchRef}
            aria-label="Sök patient"
            placeholder="Sök patient…"
            maxLength={120}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌘K</kbd>
        </form>
        <details className="admin-user">
          <summary aria-label="Konto">
            <span className="admin-avatar">{initials(adminName)}</span>
          </summary>
          <div className="admin-menu">
            <strong>{adminName}</strong>
            <small>Administratör</small>
            {session.clinical !== false && (
              <a href={demo ? "/demo" : links.clinical}>
                <ArrowLeft size={16} />
                Till vårdportalen
              </a>
            )}
            <button onClick={() => void onLogout()}>
              <LogOut size={16} />
              Logga ut
            </button>
          </div>
        </details>
      </header>
      <aside className="sidebar admin-rail">
        <nav>
          {(
            [
              ["overview", "Översikt", LayoutDashboard],
              ["newpatients", "Nya registreringar", UserPlus],
              ["system", "System", Network],
              ["staff", "Personal", Users],
              ["patients", "Sök patient", Search],
              ["history", "Historik", History],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              className={"nav-item " + (tab === id ? "selected" : "")}
              onClick={() => {
                setTab(id);
                setShowAll(false);
                if (query) {
                  setQuery("");
                  void load("");
                }
                setEditor(null);
                setNotice("");
              }}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
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
          {tab === "newpatients" ? <PatientsOverview key={organizationId} organizationId={organizationId} demo={demo} registeredFallback={data?.patients.filter((p) => p.active).length ?? 0} /> : tab === "overview" ? <Dashboard data={data} busy={busy} onTab={setTab} /> : tab === "system" ? <SystemOverview
            key={organizationId}
            organizationId={organizationId}
            demo={demo}
            administration={data}
            onStaff={() => setTab("staff")}
          /> : <>
          {tab === "staff" && <div className="page-heading">
            <button
              className="button primary"
              disabled={busy || !organizationId}
              onClick={() => setEditor({ kind: "invite" })}
            >
              <Plus size={17} />
              Lägg till personal
            </button>
          </div>}
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
          /> : null}
          {busy && !data && <p role="status">Hämtar administrationen…</p>}
          </>}
          {data && tab === "staff" && (
            <>
              <details className="admin-details">
              <summary>Personallista</summary>
              <section className="panel">
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
              {data.invitations.some((i) => invitationState(i) === "Väntar på aktivering") && <section className="panel">
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
            <section className="patients-page">
              <div className="patients-toolbar">
                <form
                  className="search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setShowAll(false);
                    void load();
                  }}
                >
                  <Search size={18} />
                  <input
                    aria-label="Sök patient i administrationen"
                    placeholder="Sök patient på namn eller personnummer"
                    value={query}
                    maxLength={120}
                    autoFocus
                    onChange={(e) => {
                      setQuery(e.target.value);
                      if (!e.target.value) setShowAll(false);
                    }}
                  />
                  <button className="button primary" disabled={busy}>
                    Sök
                  </button>
                </form>
                <button
                  className={"button secondary" + (showAll ? " active" : "")}
                  disabled={busy}
                  onClick={() => {
                    setQuery("");
                    setShowAll(true);
                    void load("");
                  }}
                >
                  <Users size={17} />
                  Alla patienter
                </button>
                <button
                  className="button primary"
                  disabled={busy || !organizationId}
                  onClick={() => setEditor({ kind: "patient" })}
                >
                  <Plus size={17} />
                  Koppla patientkonto
                </button>
              </div>
              {!query.trim() && !showAll ? (
                <div className="empty">
                  <Search size={28} />
                  <h3>Sök efter en patient</h3>
                </div>
              ) : data.patients.length ? (
                <div className="panel">
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
                                .filter(
                                  (a) => a.patient_id === p.id && a.active,
                                )
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
                </div>
              ) : (
                <div className="empty">
                  <h3>Inga patienter hittades</h3>
                </div>
              )}
            </section>
          )}
          {data && tab === "history" && (
            <section className="panel">
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

function Dashboard({
  data,
  busy,
  onTab,
}: {
  data: AdministrationData | null;
  busy: boolean;
  onTab: (tab: "system" | "staff" | "patients" | "history") => void;
}) {
  if (!data)
    return busy ? <p role="status">Hämtar…</p> : null;
  const staff = data.members.filter((m) => m.active && m.role !== "admin"),
    admins = data.members.filter((m) => m.active && m.role === "admin").length,
    waiting = data.invitations.filter(
      (i) => invitationState(i) === "Väntar på aktivering",
    ),
    activePatients = data.patients.filter((p) => p.active),
    assigned = new Set(
      data.assignments.filter((a) => a.active).map((a) => a.patient_id),
    ),
    unassigned = activePatients.filter((p) => !assigned.has(p.id)),
    unverified = activePatients.filter((p) => !p.identity_verified),
    load = staff
      .map((m) => ({
        m,
        n:
          m.patient_count ??
          data.assignments.filter((a) => a.active && a.clinician_id === m.user_id)
            .length,
      }))
      .sort((a, b) => b.n - a.n),
    max = Math.max(1, ...load.map((l) => l.n)),
    attention = [
      {
        n: unassigned.length,
        label: "Patienter utan behandlare",
        tab: "patients" as const,
      },
      {
        n: unverified.length,
        label: "Patienter med overifierad identitet",
        tab: "patients" as const,
      },
      {
        n: waiting.length,
        label: "Väntar på aktivering",
        tab: "staff" as const,
      },
      {
        n: data.members.filter((m) => !m.active).length,
        label: "Inaktiva konton",
        tab: "staff" as const,
      },
    ].filter((a) => a.n > 0);
  return (
    <div className="dashboard">
      <div className="dashboard-tiles">
        <button onClick={() => onTab("staff")}>
          <Users size={20} />
          <strong>{staff.length}</strong>
          <span>Behandlare</span>
        </button>
        <button onClick={() => onTab("staff")}>
          <ShieldCheck size={20} />
          <strong>{admins}</strong>
          <span>Administratörer</span>
        </button>
        <button onClick={() => onTab("patients")}>
          <ClipboardList size={20} />
          <strong>{activePatients.length}</strong>
          <span>Patienter</span>
        </button>
        <button onClick={() => onTab("staff")}>
          <Plus size={20} />
          <strong>{waiting.length}</strong>
          <span>Väntar på aktivering</span>
        </button>
      </div>
      <div className="dashboard-columns">
        <section className="panel dashboard-card">
          <h2>Kräver åtgärd</h2>
          {attention.length ? (
            <ul className="dashboard-list">
              {attention.map((a) => (
                <li key={a.label}>
                  <button onClick={() => onTab(a.tab)}>
                    <span className="dashboard-count">{a.n}</span>
                    {a.label}
                    <ArrowRight size={15} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dashboard-ok">
              <CheckCircle2 size={17} />
              Inget att göra
            </p>
          )}
        </section>
        <section className="panel dashboard-card">
          <h2>Patienter per behandlare</h2>
          {load.length ? (
            <ul className="dashboard-load">
              {load.map(({ m, n }) => (
                <li key={m.user_id}>
                  <span>
                    {m.display_name}
                    <small>{roleNames[m.role]}</small>
                  </span>
                  <i style={{ width: (n / max) * 100 + "%" }} />
                  <b>{n}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dashboard-ok">Ingen aktiv personal</p>
          )}
        </section>
      </div>
      <section className="panel dashboard-card">
        <h2>
          Senaste händelser
          <button onClick={() => onTab("history")}>
            Visa alla <ArrowRight size={14} />
          </button>
        </h2>
        <ul className="dashboard-events">
          {data.audit.slice(0, 6).map((a, i) => (
            <li key={i}>
              <span>{auditNames[a.action] ?? "Administrationsåtgärd"}</span>
              <time>
                {new Date(a.created_at).toLocaleString("sv-SE", {
                  timeZone: "Europe/Stockholm",
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </time>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Download,
  FileCheck2,
  FlaskConical,
  Heart,
  History,
  ImageIcon,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  ShieldCheck,
  Stethoscope,
  Syringe,
  Users,
  X,
} from "lucide-react";
import {
  catalog,
  ClinicalDateError,
  displayStatus,
  parseLocalDateTime,
  validatePayload,
  type ClinicalRecord,
  type Kind,
  type Observation,
  type Patient,
  type PatientDetail,
  type Payload,
} from "@/lib/model";
import { demoDetail, demoPatients, demoPublish } from "@/lib/demo";
import { AdministrationWorkspace } from "@/components/administration";
import { portalSessionReady, type PortalSession as Session } from "@/lib/administration";
import { localPortalLinks, type PortalLinks } from "@/lib/portal-origins";
import { CT_ARCHIVE_MAX_BYTES } from "@/lib/ct-archive";
import { CtArchiveRequestError, ctArchiveRequest, uploadCtArchive, type CtArchiveUpload } from "@/lib/ct-archive-upload";
const tabs = [
  ["overview", "Översikt", LayoutDashboard],
  ["lab", "Blodprover", FlaskConical],
  ["imaging", "Bilddiagnostik", ImageIcon],
  ["vaccination", "Vaccinationer", Syringe],
  ["vitals", "Vitalparametrar", Activity],
  ["history", "Historik", History],
] as const;
type Tab = (typeof tabs)[number][0];
const date = (value: string) =>
  new Date(value).toLocaleDateString("sv-SE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const timestamp = (value: string) =>
  new Date(value).toLocaleString("sv-SE", {
    dateStyle: "short",
    timeStyle: "short",
  });
async function api(path: string, body?: unknown) {
  const r = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Tjänsten kunde inte nås.");
  return data;
}

export function Portal({
  demo,
  administration = false,
  links = localPortalLinks,
}: {
  demo: boolean;
  administration?: boolean;
  links?: PortalLinks;
}) {
  const [session, setSession] = useState<Session | null>(
    demo
      ? {
          staff: true,
          clinical: true,
          admin: true,
          userId: "10000000-0000-4000-8000-000000000010",
          organizations: [
            {
              id: "30000000-0000-4000-8000-000000000010",
              name: "GoHealth · testmottagning",
            },
          ],
          aal: "aal2",
          name: "Sofia · testadministratör",
          role: "doctor",
        }
      : null,
  );
  const [checking, setChecking] = useState(!demo),
    [patients, setPatients] = useState<Patient[]>(demo ? demoPatients : []),
    [query, setQuery] = useState(""),
    [detail, setDetail] = useState<PatientDetail | null>(null),
    [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [editor, setEditor] = useState<{
      kind: Kind;
      record?: ClinicalRecord;
      correction?: boolean;
    } | null>(null),
    [publishing, setPublishing] = useState<ClinicalRecord | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const demoCache = useRef(new Map<string, PatientDetail>()),
    requestId = useRef(0),
    listRequestId = useRef(0);
  useEffect(() => {
    if (demo) return;
    let active = true;
    api("auth")
      .then((value) => {
        if (active) setSession(value);
      })
      .catch(() => {
        if (active) setSession(null);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [demo]);
  useEffect(() => {
    const token = ++listRequestId.current;
    if (
      !demo &&
      session && portalSessionReady(session) &&
      session.clinical !== false &&
      !administration
    )
      api("clinical", { action: "list", query: "" })
        .then((value) => {
          if (token === listRequestId.current) setPatients(value);
        })
        .catch((e) => {
          if (token === listRequestId.current) setError(e.message);
        });
    return () => {
      listRequestId.current++;
    };
  }, [demo, session, administration]);
  useEffect(() => {
    if (!session || !portalSessionReady(session)) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          if (!demo) {
            requestId.current++;
            listRequestId.current++;
            void api("auth", { action: "logout" });
            setSession(null);
            setPatients([]);
            setDetail(null);
            setEditor(null);
            setPublishing(null);
            setBusy(false);
            setNotice("Sessionen avslutades efter 15 minuters inaktivitet.");
          }
        },
        15 * 60 * 1000,
      );
    };
    reset();
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [demo, session]);
  async function search(e: FormEvent) {
    e.preventDefault();
    const token = ++listRequestId.current;
    setError("");
    setBusy(true);
    try {
      if (demo) {
        setPatients(
          demoPatients.filter((p) =>
            `${p.display_name} ${p.identity_label}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          ),
        );
      } else {
        const value = await api("clinical", { action: "list", query });
        if (token === listRequestId.current) setPatients(value);
      }
    } catch (e) {
      if (token === listRequestId.current) setError((e as Error).message);
    } finally {
      if (token === listRequestId.current) setBusy(false);
    }
  }
  async function open(patient: Patient) {
    const token = ++requestId.current;
    setDetail(null);
    setEditor(null);
    setTab("overview");
    setError("");
    setBusy(true);
    try {
      const data = demo
        ? demoCache.current.get(patient.id) || demoDetail(patient)
        : await api("clinical", { action: "patient", patientId: patient.id });
      if (token === requestId.current) setDetail(data);
    } catch (e) {
      if (token === requestId.current) setError((e as Error).message);
    } finally {
      if (token === requestId.current) setBusy(false);
    }
  }
  async function reload(patientId: string, token: number) {
    if (token !== requestId.current) return;
    const data = demo
      ? demoCache.current.get(patientId)
      : await api("clinical", {
          action: "patient",
          patientId,
        });
    if (data && token === requestId.current) setDetail(data);
  }
  function storeDemo(data: PatientDetail) {
    demoCache.current.set(data.patient.id, data);
    setDetail(data);
  }
  async function save(payload: unknown, reason: string) {
    if (!detail || !editor) return;
    const token = requestId.current;
    setError("");
    const parsed = validatePayload(editor.kind, payload);
    const original = editor.record;
    const correction = editor.correction === true;
    if (demo) {
      const previous = correction ? null : original;
      const record: ClinicalRecord = {
        id: previous?.id || crypto.randomUUID(),
        patient_id: detail.patient.id,
        kind: editor.kind,
        status: "draft",
        version: correction ? original!.version + 1 : original?.version || 1,
        revision: (previous?.revision || 0) + 1,
        replaces_id: correction ? original!.id : original?.replaces_id || null,
        superseded_at: null,
        payload: parsed as Payload,
        published_at: null,
        created_at: previous?.created_at || new Date().toISOString(),
        correction_reason: reason || null,
      };
      storeDemo({
        ...detail,
        records: [record, ...detail.records.filter((x) => x.id !== record.id)],
        audit: [
          { action: "Utkast sparat", created_at: new Date().toISOString() },
          ...detail.audit,
        ],
      });
    } else {
      const saved: ClinicalRecord = await api("clinical", {
        action: "save",
        patientId: detail.patient.id,
        kind: editor.kind,
        payload: parsed,
        recordId: correction ? null : original?.id || null,
        expectedRevision: correction ? 0 : original?.revision || 0,
        replacesId: correction ? original!.id : original?.replaces_id || null,
        correctionReason: reason,
      });
      if (token === requestId.current) {
        setDetail((current) => current && current.patient.id === saved.patient_id
          ? { ...current, records: [saved, ...current.records.filter((r) => r.id !== saved.id)] }
          : current,
        );
        void reload(detail.patient.id, token).catch(() => undefined);
      }
    }
    if (token !== requestId.current) return;
    setEditor(null);
    setNotice("Utkastet är sparat. Granska det före publicering.");
    setTab(editor.kind);
  }
  async function publish() {
    if (!publishing || !detail) return;
    const token = requestId.current;
    setBusy(true);
    setError("");
    try {
      if (demo)
        storeDemo({
          ...detail,
          records: demoPublish(
            detail.records,
            publishing.id,
            new Date().toISOString(),
          ),
          audit: [
            { action: "Svar publicerat", created_at: new Date().toISOString() },
            ...detail.audit,
          ],
        });
      else {
        await api("clinical", {
          action: "publish",
          recordId: publishing.id,
          expectedRevision: publishing.revision,
        });
        await reload(detail.patient.id, token);
      }
      if (token !== requestId.current) return;
      setPublishing(null);
      setNotice(
        demo
          ? "Publicerat i testprofilens patientvy. Inga uppgifter skickas till en verklig app."
          : "Publicerat. Patienten kan nu hämta svaret i GoHealth.",
      );
    } catch (e) {
      if (token === requestId.current) setError((e as Error).message);
    } finally {
      if (token === requestId.current) setBusy(false);
    }
  }
  async function logout() {
    requestId.current++;
    listRequestId.current++;
    setDetail(null);
    setPatients([]);
    setEditor(null);
    setPublishing(null);
    setBusy(false);
    setError("");
    setNotice("");
    setSession(null);
    if (!demo) {
      try {
        await api("auth", { action: "logout" });
      } catch {
        setError(
          "Utloggningen kunde inte bekräftas av servern. Stäng webbläsaren och kontakta administratören om felet kvarstår.",
        );
      }
    }
  }
  if (checking)
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <Brand />
          <p role="status">Kontrollerar din session…</p>
        </div>
      </main>
    );
  if (session && links.separateDomains && (
    (!administration && session.admin && session.clinical === false) ||
    (administration && !session.admin && session.clinical !== false)
  )) {
    const toAdministration = !administration;
    return (
      <main className="activation-shell">
        <section className="activation-card">
          <Brand />
          <h1>{toAdministration ? "Öppna administrationen" : "Öppna vårdportalen"}</h1>
          <p>Din behörighet hör till den andra arbetsytan. Logga in där med samma personliga konto.</p>
          <a className="button primary" href={toAdministration ? links.administration : links.clinical}>
            {toAdministration ? "Till administrationen" : "Till vårdportalen"} <ArrowRight size={17} />
          </a>
          <button className="text-button" onClick={() => void logout()}>Logga ut här</button>
        </section>
      </main>
    );
  }
  if (!session || !portalSessionReady(session))
    return (
      <Login
        demo={demo}
        administration={administration}
        activationUrl={links.activation}
        session={session?.mfa_required === false ? null : session}
        message={error || notice}
        onSession={(value) => {
          setError("");
          setNotice("");
          setSession(value);
        }}
      />
    );
  if (administration || (session.admin && session.clinical === false))
    return (
      <AdministrationWorkspace
        demo={demo}
        session={session}
        onLogout={logout}
        links={links}
      />
    );
  const records = detail?.records.filter((x) => !x.superseded_at) || [],
    published = records.filter((x) => x.status === "published"),
    drafts = records.filter((x) => x.status === "draft");
  return (
    <div className={`workspace clinical-workspace${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">VÅRDPORTALEN</div>
        <nav id="clinical-navigation" aria-label="Vårdportalens meny">
          {session.admin && (
            <a className="nav-item" href={demo ? "/demo/admin" : links.administration} aria-label="Administration" title="Administration">
              <ShieldCheck size={18} />
              <span className="nav-label">Administration</span>
            </a>
          )}
          <button
            className="nav-item selected"
            aria-label={`Mina patienter (${patients.length})`}
            title="Mina patienter"
            onClick={() => {
              requestId.current++;
              setDetail(null);
              setEditor(null);
              setPublishing(null);
              setBusy(false);
            }}
          >
            <Users size={18} />
            <span className="nav-label">Mina patienter</span><span className="nav-count">{patients.length}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="shield-note" title="Behörighetsstyrd åtkomst · Personligt konto · två faktorer">
            <ShieldCheck size={19} />
            <span>
              Behörighetsstyrd åtkomst
              <small>Personligt konto · två faktorer</small>
            </span>
          </div>
          <div className="staff">
            <div className="staff-avatar" title={session.name}>
              <Stethoscope size={20} />
            </div>
            <div className="staff-details">
              <strong>{session.name}</strong>
              <small>
                {session.role === "doctor" ? "Läkare" : "Vårdpersonal"}
              </small>
            </div>
            <button title="Logga ut" aria-label="Logga ut" onClick={logout}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-navigation">
            <button
              className="sidebar-toggle"
              type="button"
              aria-label={sidebarCollapsed ? "Expandera vänstermenyn" : "Fäll ihop vänstermenyn"}
              title={sidebarCollapsed ? "Expandera vänstermenyn" : "Fäll ihop vänstermenyn"}
              aria-expanded={!sidebarCollapsed}
              aria-controls="clinical-navigation"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
            </button>
            <span>
              Vårdteam <ChevronRight size={14} /> Mina patienter{" "}
              {detail && (
                <>
                  <ChevronRight size={14} />
                  <strong>{detail.patient.display_name}</strong>
                </>
              )}
            </span>
          </div>
          <span className="secure">
            <LockKeyhole size={13} /> Skyddad arbetsyta
          </span>
        </header>
        {demo && (
          <div className="demo-banner">
            <span>
              <strong>Demonstrationsmiljö</strong> · Alla patienter och resultat
              är syntetiska. Ändringar finns bara i denna flik.
            </span>
            <a href="/">
              Till inloggningen <ArrowRight size={14} />
            </a>
          </div>
        )}
        <main className="content">
          {error && (
            <div role="alert" className="alert error">
              {error}
              <button
                aria-label="Stäng felmeddelande"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="alert success">
              {notice}
              <button
                aria-label="Stäng meddelande"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!detail ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>
                    Mina patienter<span>.</span>
                  </h1>
                </div>
                <div className="round-symbol">
                  <Stethoscope size={28} />
                </div>
              </div>
              <div className="stats">
                <Stat
                  label="Patienter i listan"
                  value={String(patients.length)}
                  icon={<Users />}
                />
                <Stat
                  label="Aktiv arbetsyta"
                  value="Patientuppföljning"
                  icon={<ClipboardList />}
                />
                <Stat
                  label="Åtkomst"
                  value="Dina vårdrelationer"
                  icon={<ShieldCheck />}
                />
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Patientöversikt</h2>
                    <p>Sök bland de patienter du har behörighet att följa.</p>
                  </div>
                  <span className="pill">{patients.length} patienter</span>
                </div>
                <form className="search" onSubmit={search}>
                  <Search size={18} />
                  <input
                    aria-label="Sök patient"
                    placeholder="Sök på namn eller exakt personnummer"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    maxLength={120}
                  />
                  <button className="button secondary" disabled={busy}>
                    Sök
                  </button>
                </form>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Patient</th>
                        <th>Identitet</th>
                        <th>Senaste datasynk</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {patients.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <button
                              className="patient-link"
                              onClick={() => open(p)}
                            >
                              <span className="patient-avatar">
                                {p.display_name
                                  .split(" ")
                                  .map((x) => x[0])
                                  .slice(0, 2)
                                  .join("")}
                              </span>
                              <strong>{p.display_name}</strong>
                            </button>
                          </td>
                          <td>
                            <div>{p.identity_label}</div>
                            <small
                              className={
                                p.identity_verified ? "muted" : "warning"
                              }
                            >
                              {p.identity_verified
                                ? "Verifierad kontokoppling"
                                : "Identitetskontroll återstår"}
                            </small>
                          </td>
                          <td>
                            {p.last_sync_at ? (
                              timestamp(p.last_sync_at)
                            ) : (
                              <span className="muted">Ingen synk ännu</span>
                            )}
                          </td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={`Öppna ${p.display_name}`}
                              onClick={() => open(p)}
                            >
                              <ArrowRight size={18} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!patients.length && (
                  <Empty
                    title="Inga patienter att visa"
                    description="En administratör behöver koppla ditt personalkonto till verifierade patienter."
                  />
                )}
              </section>
              <p className="footnote">
                Personnummer används för sökning. Åtkomst styrs alltid av din
                aktuella vårdrelation.
              </p>
            </>
          ) : (
            <>
              <button
                className="back"
                onClick={() => {
                  requestId.current++;
                  setDetail(null);
                  setEditor(null);
                  setPublishing(null);
                  setBusy(false);
                }}
              >
                <ArrowLeft size={16} /> Patientöversikt
              </button>
              <div className="patient-heading">
                <div className="patient-avatar large">
                  {detail.patient.display_name
                    .split(" ")
                    .map((x) => x[0])
                    .slice(0, 2)
                    .join("")}
                </div>
                <div>
                  <p className="eyebrow">PATIENTPROFIL</p>
                  <h1>{detail.patient.display_name}</h1>
                  <div className="identity">
                    {detail.patient.identity_label}
                    <span className="pill">
                      {detail.patient.identity_verified
                        ? "Verifierad kontokoppling"
                        : "Ej verifierad"}
                    </span>
                  </div>
                </div>
                <div className="patient-heading-meta">
                  <small>SENASTE DATASYNK</small>
                  <strong>
                    {detail.patient.last_sync_at
                      ? timestamp(detail.patient.last_sync_at)
                      : "Ingen synk registrerad"}
                  </strong>
                </div>
              </div>
              {!detail.patient.identity_verified && (
                <div className="alert error">
                  Kontokopplingen måste verifieras av administratören innan
                  uppgifter kan publiceras.
                </div>
              )}
              <div
                className="tabs"
                role="tablist"
                aria-label="Patientuppgifter"
              >
                {tabs.map(([id, label, Icon]) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    className={tab === id ? "active" : ""}
                    onClick={() => setTab(id)}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                ))}
              </div>
              {tab === "overview" ? (
                <>
                  <div className="stats">
                    <Stat
                      label="Publicerade svar"
                      value={String(published.length)}
                      icon={<FileCheck2 />}
                    />
                    <Stat
                      label="Utkast att granska"
                      value={String(drafts.length)}
                      icon={<ClipboardList />}
                    />
                    <Stat
                      label="Mätningar hämtade"
                      value={String(detail.vitals.length)}
                      icon={<Activity />}
                    />
                  </div>
                  <div className="overview-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Senaste provsvaren</h2>
                          <p>Publicerade uppgifter för patienten.</p>
                        </div>
                        <FlaskConical size={20} />
                      </div>
                      {published.filter((x) => x.kind === "lab").length ? (
                        published
                          .filter((x) => x.kind === "lab")
                          .slice(0, 3)
                          .map((r) => (
                            <RecordCard
                              key={r.id}
                              record={r}
                              onEdit={() =>
                                setEditor({
                                  kind: r.kind,
                                  record: r,
                                  correction: true,
                                })
                              }
                            />
                          ))
                      ) : (
                        <Empty
                          title="Inga publicerade blodprover"
                          description="Registrera det första provtagningstillfället för att bygga patientens historik."
                        />
                      )}
                      <button
                        className="text-button"
                        onClick={() => setTab("lab")}
                      >
                        Visa blodprover <ArrowRight size={15} />
                      </button>
                    </section>
                    <section className="panel tinted">
                      <div className="panel-heading">
                        <div>
                          <h2>Nästa arbetssteg</h2>
                          <p>Registrera nya uppgifter i patientens profil.</p>
                        </div>
                      </div>
                      {(["lab", "vaccination", "imaging"] as Kind[]).map(
                        (kind, i) => (
                          <button
                            key={kind}
                            className="action-row"
                            onClick={() => setEditor({ kind })}
                          >
                            <span className="step-number">0{i + 1}</span>
                            <span>
                              <strong>
                                {kind === "lab"
                                  ? "Registrera blodprover"
                                  : kind === "vaccination"
                                    ? "Registrera vaccination"
                                    : "Registrera bildutlåtande"}
                              </strong>
                              <small>
                                {kind === "lab"
                                  ? "Resultat, källa och referensintervall"
                                  : kind === "vaccination"
                                    ? "Vaccin, dos och vaccinationsdatum"
                                    : "Undersökning och granskat utlåtande"}
                              </small>
                            </span>
                            <Plus size={18} />
                          </button>
                        ),
                      )}
                      <div className="info-note">
                        <LockKeyhole size={16} />
                        <p>
                          Utkast visas för vårdteamet. Publicerade svar blir
                          tillgängliga i patientens app.
                        </p>
                      </div>
                    </section>
                  </div>
                </>
              ) : tab === "history" ? (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Åtkomst och ändringar</h2>
                      <p>
                        Senaste händelser för denna patient. Historiken
                        innehåller inga provvärden.
                      </p>
                    </div>
                  </div>
                  {detail.audit.length ? (
                    detail.audit.map((a, i) => (
                      <div key={i} className="history-row">
                        <CheckCircle2 size={17} />
                        <strong>{a.action}</strong>
                        <span>{timestamp(a.created_at)}</span>
                      </div>
                    ))
                  ) : (
                    <Empty
                      title="Inga händelser"
                      description="Händelser visas när patientuppgifter öppnas eller ändras."
                    />
                  )}
                </section>
              ) : tab === "vitals" ? (
                <Vitals detail={detail} />
              ) : (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        {tab === "lab"
                          ? "Blodprover"
                          : tab === "vaccination"
                            ? "Vaccinationer"
                            : "Bilddiagnostik"}
                      </h2>
                      <p>
                        {tab === "lab"
                          ? "Provtagningstillfällen, enskilda resultat och läkarens kommentar."
                          : tab === "vaccination"
                            ? "Granskade doser och uppgifter om registreringens källa."
                            : "Utlåtanden och referenser till undersökningar."}
                      </p>
                    </div>
                    <button
                      className="button primary"
                      onClick={() => setEditor({ kind: tab as Kind })}
                    >
                      <Plus size={16} />
                      Registrera{" "}
                      {tab === "lab"
                        ? "provsvar"
                        : tab === "vaccination"
                          ? "vaccination"
                          : "utlåtande"}
                    </button>
                  </div>
                  {tab === "imaging" && (
                    <div className="info-note">
                      <ImageIcon size={18} />
                      <p>
                        Bifoga DT-bilder som en ZIP-fil när du registrerar ett utlåtande.
                        Patienten kan öppna bilderna i GoHealth när du publicerar utlåtandet.
                      </p>
                    </div>
                  )}
                  {records.filter((x) => x.kind === tab).length ? (
                    records
                      .filter((x) => x.kind === tab)
                      .map((r) => (
                        <RecordCard
                          key={r.id}
                          record={r}
                          canPublish={session.role === "doctor"}
                          onEdit={() =>
                            setEditor({
                              kind: r.kind,
                              record: r,
                              correction: r.status === "published",
                            })
                          }
                          onPublish={() => setPublishing(r)}
                        />
                      ))
                  ) : (
                    <Empty
                      title="Inga uppgifter registrerade"
                      description="Börja med ett utkast. Granska innehållet innan det publiceras till patienten."
                    />
                  )}
                  {detail.records.some(
                    (x) => x.kind === tab && x.superseded_at,
                  ) && (
                    <details className="previous">
                      <summary>Tidigare, rättade versioner</summary>
                      {detail.records
                        .filter((x) => x.kind === tab && x.superseded_at)
                        .map((r) => (
                          <RecordCard key={r.id} record={r} />
                        ))}
                    </details>
                  )}
                </section>
              )}
            </>
          )}
          {busy && (
            <div className="loading" role="status">
              Arbetar…
            </div>
          )}
        </main>
      </div>
      {editor && detail && (
        <Editor
          key={editor.record?.id || editor.kind}
          kind={editor.kind}
          patient={detail.patient}
          record={editor.record}
          correction={editor.correction}
          canAttachCt={!demo}
          onClose={() => setEditor(null)}
          onSave={save}
        />
      )}
      {publishing && detail && (
        <Dialog
          onClose={() => setPublishing(null)}
          title="Granska och publicera"
        >
          <p className="dialog-patient">
            {detail.patient.display_name} · {detail.patient.identity_label}
          </p>
          <RecordCard record={publishing} />
          <p>
            Bekräfta att rätt patient, datum, källa och samtliga uppgifter har
            kontrollerats. {publishing.payload.archiveId
              ? "Utlåtandet och de bifogade bilderna blir tillgängliga i patientens app."
              : "Svaret blir tillgängligt i patientens app."}
          </p>
          <div className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => setPublishing(null)}
            >
              Avbryt
            </button>
            <button
              className="button primary"
              onClick={publish}
              disabled={busy || !detail.patient.identity_verified}
            >
              <Check size={16} />
              Publicera till patienten
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Heart size={24} />
      </span>
      <span>
        Go<span>Health</span>
        <i>.</i>
      </span>
    </div>
  );
}
function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-icon">{icon}</div>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}
function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty">
      <ClipboardList size={25} />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
function RecordCard({
  record: r,
  onEdit,
  onPublish,
  canPublish,
}: {
  record: ClinicalRecord;
  onEdit?: () => void;
  onPublish?: () => void;
  canPublish?: boolean;
}) {
  return (
    <article className="record">
      <div className="record-top">
        <div>
          <span
            className={`pill ${r.status === "draft" ? "draft" : "published"}`}
          >
            {r.superseded_at
              ? "Rättad version"
              : r.status === "draft"
                ? "Utkast"
                : "Publicerat"}
          </span>
          <span className="version">Version {r.version}</span>
          <h3>{r.payload.title}</h3>
          <p>
            {date(r.payload.sampledAt)} · {r.payload.source}
          </p>
        </div>
        {onEdit && (
          <button className="button secondary small" onClick={onEdit}>
            {r.status === "draft" ? "Redigera" : "Skapa rättelse"}
          </button>
        )}
      </div>
      {r.kind === "lab" ? (
        <div className="table-scroll">
          <table className="results">
            <thead>
              <tr>
                <th>Analys</th>
                <th>Resultat</th>
                <th>Referens</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {r.payload.observations.map((o) => (
                <tr key={o.code}>
                  <td>{o.name}</td>
                  <td>
                    <strong>
                      {o.comparator === "=" || o.comparator === "text"
                        ? ""
                        : o.comparator}
                      {o.value} <small>{o.unit}</small>
                    </strong>
                  </td>
                  <td>
                    {o.referenceText ||
                      `${o.referenceLow ?? "—"} – ${o.referenceHigh ?? "—"}`}
                  </td>
                  <td>
                    <span
                      className={
                        displayStatus(o) === "Utanför intervall"
                          ? "warning"
                          : "muted"
                      }
                    >
                      {displayStatus(o)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : r.kind === "vaccination" ? (
        <p>
          <strong>{r.payload.vaccine}</strong> · Dos {r.payload.dose} ·{" "}
          {r.payload.location}
          {r.payload.batch && ` · Batch ${r.payload.batch}`}
        </p>
      ) : (
        <>
          <p>
            <strong>
              {r.payload.modality} · {r.payload.bodyPart}
            </strong>
          </p>
          <p className="prewrap">{r.payload.conclusion}</p>
          {r.payload.studyId && (
            <small>Undersöknings-ID: {r.payload.studyId}</small>
          )}
          {r.payload.archiveId && <CtArchiveDownload recordId={r.id} />}
        </>
      )}
      {r.payload.comment && <p className="comment">{r.payload.comment}</p>}
      {r.correction_reason && (
        <p className="muted">Rättelseorsak: {r.correction_reason}</p>
      )}
      <div className="record-footer">
        <small>
          Manuellt registrerat
          {r.published_at && ` · Granskat ${timestamp(r.published_at)}`}
        </small>
        {r.status === "draft" && onPublish && (
          <button
            className="button primary small"
            onClick={onPublish}
            disabled={!canPublish}
          >
            <FileCheck2 size={15} />
            {canPublish ? "Granska och publicera" : "Läkare behöver publicera"}
          </button>
        )}
      </div>
    </article>
  );
}
function CtArchiveDownload({ recordId }: { recordId: string }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    setDownloading(true);
    setError("");
    try {
      const { url } = await ctArchiveRequest<{ url: string }>({ action: "download", recordId });
      const link = document.createElement("a");
      link.href = url;
      link.download = "DT-bilder.zip";
      link.click();
    } catch (error) {
      setError(error instanceof Error ? error.message : "ZIP-filen kunde inte hämtas.");
    } finally {
      setDownloading(false);
    }
  }
  return (
    <div className="ct-archive-download">
      <button type="button" className="button secondary small" onClick={download} disabled={downloading}>
        <Download size={15} /> {downloading ? "Hämtar…" : "Hämta DT-bilder (ZIP)"}
      </button>
      {error && <p role="alert" className="alert error">{error}</p>}
    </div>
  );
}
function Vitals({ detail }: { detail: PatientDetail }) {
  const kinds = [...new Set(detail.vitals.map((v) => v.kind))];
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Vitalparametrar</h2>
          <p>Mätningar som patienten har delat från Apple Hälsa.</p>
        </div>
        <Activity size={20} />
      </div>
      {!kinds.length ? (
        <Empty
          title="Inga delade mätningar ännu"
          description="Patienten behöver aktivera delning till vårdteamet i GoHealth-appen. Avsaknad av data är inte ett normalt mätvärde."
        />
      ) : (
        kinds.map((kind) => {
          const values = detail.vitals
            .filter((v) => v.kind === kind)
            .sort((a, b) => a.end_at.localeCompare(b.end_at));
          const latest = values.at(-1)!;
          const numeric = values.filter((v) => v.value !== null);
          const min = Math.min(...numeric.map((v) => v.value!)),
            max = Math.max(...numeric.map((v) => v.value!));
          const points = numeric
            .map(
              (v, i) =>
                `${10 + (i * 480) / Math.max(1, numeric.length - 1)},${70 - ((v.value! - min) * 55) / Math.max(1, max - min)}`,
            )
            .join(" ");
          return (
            <article className="vital" key={kind}>
              <div>
                <h3>
                  {kind === "resting-heart-rate"
                    ? "Vilopuls"
                    : kind === "heart-rate"
                      ? "Puls"
                      : kind === "sleep"
                        ? "Registrerad sömn"
                        : kind}
                </h3>
                <strong>
                  {latest.value ?? "Registrerad händelse"}{" "}
                  <small>{latest.unit}</small>
                </strong>
                <p>
                  {timestamp(latest.end_at)} · {latest.source}
                </p>
              </div>
              {numeric.length > 1 && (
                <svg
                  viewBox="0 0 500 90"
                  role="img"
                  aria-label={`Trend för ${kind}; ${numeric.length} mätningar`}
                >
                  <polyline
                    points={points}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                </svg>
              )}
              <small>
                {values.length} mätningar · Tid visas i din webbläsares tidszon
              </small>
            </article>
          );
        })
      )}
    </section>
  );
}

function Login({
  demo,
  administration,
  activationUrl,
  session,
  message,
  onSession,
}: {
  demo: boolean;
  administration: boolean;
  activationUrl: string;
  session: Session | null;
  message: string;
  onSession: (s: Session) => void;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [factor, setFactor] = useState<{
      factorId: string;
      qr?: string;
      secret?: string;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const preparation = useRef<Promise<{
    factorId: string;
    qr?: string;
    secret?: string;
  }> | null>(null);
  async function prepareFactor() {
    setBusy(true);
    setError("");
    try {
      // React may repeat an effect in development; reuse the enrollment request.
      preparation.current ??= api("mfa", { action: "prepare" });
      setFactor(await preparation.current);
    } catch (e) {
      preparation.current = null;
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function login(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      onSession(await api("auth", { action: "login", email, password }));
      setPassword("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (session && !portalSessionReady(session)) void prepareFactor();
  }, [session]);
  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!factor) return;
    setBusy(true);
    setError("");
    try {
      await api("mfa", { action: "verify", factorId: factor.factorId, code });
      onSession(await api("auth"));
      setFactor(null);
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <Brand />
        <div>
          <p className="eyebrow">GOHEALTH FÖR VÅRDTEAM</p>
          <h1>
            {administration ? "Rätt team." : "Mer sammanhang."}
            <br />
            {administration ? "Tryggare åtkomst" : "Bättre uppföljning"}<span>.</span>
          </h1>
          <p>
            {administration
              ? "Hantera personal, behörigheter och patienttilldelningar för din mottagning."
              : "Patientens mätningar, undersökningar och provsvar samlade i en trygg arbetsyta."}
          </p>
          <div className="story-features">
            <span>
              <FlaskConical />
              {administration ? "Personal och roller" : "Blodprover och trender"}
            </span>
            <span>
              <Activity />
              {administration ? "Patienttilldelningar" : "Delade hälsomätningar"}
            </span>
            <span>
              <ShieldCheck />
              Spårbar granskning
            </span>
          </div>
        </div>
        <small>GoHealth · Kontinuitet genom hela patientresan</small>
      </section>
      <section className="auth-card">
        <div className="auth-icon">
          <Stethoscope size={26} />
        </div>
        <p className="eyebrow">{administration ? "ADMINISTRATION" : "VÅRDPORTALEN"}</p>
        <h2>{session ? "Bekräfta din inloggning" : "Välkommen tillbaka"}</h2>
        {message && <p role="status">{message}</p>}
        <p>
          {session
            ? "Använd din autentiseringsapp för att fortsätta."
            : administration ? "Logga in med ditt personliga administratörskonto." : "Logga in med ditt personliga vårdgivarkonto."}
        </p>
        {error && (
          <div role="alert" className="alert error">
            {error}
          </div>
        )}
        {!session ? (
          <form onSubmit={login}>
            <label>
              E-postadress
              <input
                required
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Lösenord
              <input
                required
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy}>
              Fortsätt <ArrowRight size={17} />
            </button>
          </form>
        ) : (
          <form onSubmit={verify}>
            {!factor && error && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void prepareFactor()}
              >
                Försök hämta tvåfaktorsinloggningen igen
              </button>
            )}
            {factor?.qr && (
              <div className="mfa-setup">
                <p>
                  Skanna QR-koden i din autentiseringsapp och ange sedan koden.
                </p>
                <img
                  src={
                    factor.qr.startsWith("data:")
                      ? factor.qr
                      : `data:image/svg+xml;utf8,${encodeURIComponent(factor.qr)}`
                  }
                  alt="QR-kod för att konfigurera tvåfaktorsinloggning"
                  width={180}
                  height={180}
                />
                <details>
                  <summary>Visa inställningsnyckel</summary>
                  <code>{factor.secret}</code>
                </details>
              </div>
            )}
            <label>
              Engångskod
              <input
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy || !factor}>
              Verifiera och öppna <ArrowRight size={17} />
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                void api("auth", { action: "logout" }).then(() =>
                  location.reload(),
                )
              }
            >
              Avbryt inloggningen
            </button>
          </form>
        )}
        <div className="auth-note">
          <LockKeyhole size={16} />
          <span>
            Endast inbjuden personal har tillgång. Kontakta din administratör om
            du behöver ett konto eller hjälp med inloggningen.
          </span>
        </div>
        {!demo && (
          <>
            <a href={activationUrl + "?reset=1"}>Glömt lösenord?</a>
            <br />
            <a href={activationUrl}>Första gången? Aktivera din behörighet</a>
          </>
        )}
        {demo && <a href="/demo">Öppna testprofilen igen</a>}
      </section>
    </main>
  );
}

function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="dialog"
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Stäng" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Editor({
  kind,
  patient,
  record,
  correction,
  canAttachCt,
  onClose,
  onSave,
}: {
  kind: Kind;
  patient: Patient;
  record?: ClinicalRecord;
  correction?: boolean;
  canAttachCt: boolean;
  onClose: () => void;
  onSave: (payload: unknown, reason: string) => Promise<void>;
}) {
  const p = record?.payload;
  const [title, setTitle] = useState(
      p?.title ||
        {
          lab: "Blodprover",
          vaccination: "Vaccination",
          imaging: "Bildutlåtande",
        }[kind],
    ),
    [source, setSource] = useState(p?.source || ""),
    [sampled, setSampled] = useState(
      p
        ? new Date(
            new Date(p.sampledAt).getTime() -
              new Date(p.sampledAt).getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16)
        : "",
    ),
    [comment, setComment] = useState(p?.comment || ""),
    [reason, setReason] = useState(record?.correction_reason || ""),
    [rows, setRows] = useState<Observation[]>(
      p?.observations || [newObservation("tsh")],
    ),
    [vaccine, setVaccine] = useState(p?.vaccine || ""),
    [dose, setDose] = useState(p?.dose || ""),
    [batch, setBatch] = useState(p?.batch || ""),
    [place, setPlace] = useState(p?.location || ""),
    [modality, setModality] = useState(p?.modality || "CT"),
    [bodyPart, setBodyPart] = useState(p?.bodyPart || ""),
    [conclusion, setConclusion] = useState(p?.conclusion || ""),
    [studyId, setStudyId] = useState(p?.studyId || ""),
    [archiveId, setArchiveId] = useState(p?.archiveId),
    [archiveFile, setArchiveFile] = useState<File>(),
    [uploadProgress, setUploadProgress] = useState<number>(),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const archiveUpload = useRef<CtArchiveUpload | undefined>(undefined);
  const archiveInput = useRef<HTMLInputElement>(null);
  const sampledInput = useRef<HTMLInputElement>(null);
  const needsReason = correction || !!record?.replaces_id;
  function discardUpload(clearInput = true) {
    const id = archiveUpload.current?.id;
    archiveUpload.current = undefined;
    if (id) void ctArchiveRequest({ action: "cancel", id }).catch(() => undefined);
    setArchiveFile(undefined);
    if (clearInput && archiveInput.current) archiveInput.current.value = "";
  }
  function close() {
    if (saving) return;
    discardUpload();
    onClose();
  }
  function edit(i: number, patch: Partial<Observation>) {
    setRows(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      if (needsReason && !reason.trim())
        throw new Error("Ange orsaken till rättelsen.");
      const base = {
        title,
        source,
        sampledAt: parseLocalDateTime(sampled),
        comment,
      };
      const payload =
        kind === "lab"
          ? { ...base, observations: rows }
          : kind === "vaccination"
            ? { ...base, vaccine, dose, batch, location: place }
            : { ...base, modality, bodyPart, conclusion, studyId, archiveId: modality === "CT" ? archiveId : undefined };
      const validated = validatePayload(kind, payload);
      if (kind === "imaging" && modality === "CT" && archiveFile) {
        const reservation = archiveUpload.current ?? await ctArchiveRequest<CtArchiveUpload>({
          action: "begin",
          patientId: patient.id,
          size: archiveFile.size,
        });
        archiveUpload.current = reservation;
        setUploadProgress(reservation.uploaded ? 100 : 0);
        if (!reservation.uploaded) await uploadCtArchive(archiveFile, reservation, setUploadProgress);
        let attachment: { id: string };
        try {
          attachment = await ctArchiveRequest({ action: "finish", id: reservation.id });
        } catch (error) {
          if (error instanceof CtArchiveRequestError && error.status === 400) discardUpload();
          throw error;
        }
        await onSave({ ...validated, archiveId: attachment.id }, reason);
        archiveUpload.current = undefined;
        return;
      }
      await onSave(payload, reason);
    } catch (e) {
      if (e instanceof ClinicalDateError) sampledInput.current?.focus();
      setError(
        e instanceof Error && e.name !== "ZodError"
          ? e.message
          : "Kontrollera alla fält. Numeriska resultat och intervall måste vara giltiga.",
      );
    } finally {
      setUploadProgress(undefined);
      setSaving(false);
    }
  }
  return (
    <Dialog
      title={
        correction
          ? "Skapa rättelse"
          : record
            ? "Redigera utkast"
            : "Registrera nya uppgifter"
      }
      onClose={close}
    >
      <p className="dialog-patient">
        {patient.display_name} · {patient.identity_label}
      </p>
      <form onSubmit={submit}>
        {error && (
          <div role="alert" className="alert error">
            {error}
          </div>
        )}
        <div className="form-grid">
          <label>
            Titel
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={160}
            />
          </label>
          <label>
            {kind === "lab"
              ? "Provtagningstid"
              : kind === "vaccination"
                ? "Vaccinationstid"
                : "Undersökningstid"}
            <input
              ref={sampledInput}
              type="text"
              placeholder="ÅÅÅÅ-MM-DD TT:MM"
              maxLength={16}
              pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}"
              required
              value={sampled}
              onChange={(e) => setSampled(e.target.value)}
            />
          </label>
          <label className="full">
            {kind === "lab"
              ? "Laboratorium / originalkälla"
              : "Uppgifternas källa"}
            <input
              required
              maxLength={160}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="Ange källan till uppgifterna"
            />
          </label>
        </div>
        {kind === "lab" ? (
          <>
            <div className="editor-rows">
              {rows.map((row, i) => (
                <div className="editor-row" key={i}>
                  <div className="editor-row-top">
                    <strong>Analys {i + 1}</strong>
                    <button
                      type="button"
                      className="text-button"
                      disabled={rows.length === 1}
                      onClick={() => setRows(rows.filter((_, j) => i !== j))}
                    >
                      Ta bort
                    </button>
                  </div>
                  <div className="form-grid">
                    <label>
                      Analys
                      <select
                        value={row.code}
                        onChange={(e) =>
                          setRows(
                            rows.map((r, j) =>
                              i === j ? newObservation(e.target.value) : r,
                            ),
                          )
                        }
                      >
                        {catalog.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Enhet
                      <input
                        required={row.comparator !== "text"}
                        value={row.unit}
                        onChange={(e) => edit(i, { unit: e.target.value })}
                        maxLength={80}
                      />
                    </label>
                    <label>
                      Resultat
                      <div className="result-input">
                        <select
                          aria-label={`Resultattyp analys ${i + 1}`}
                          value={row.comparator}
                          onChange={(e) =>
                            edit(i, {
                              comparator: e.target
                                .value as Observation["comparator"],
                            })
                          }
                        >
                          {["=", "<", ">", "<=", ">=", "text"].map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                        <input
                          aria-label={`Resultat analys ${i + 1}`}
                          required
                          value={row.value}
                          onChange={(e) =>
                            edit(i, {
                              value:
                                row.comparator === "text"
                                  ? e.target.value
                                  : e.target.value.replace(",", "."),
                            })
                          }
                          maxLength={120}
                        />
                      </div>
                    </label>
                    <label>
                      Referensintervall
                      <div className="result-input">
                        <input
                          aria-label={`Nedre referens analys ${i + 1}`}
                          type="number"
                          step="any"
                          placeholder="Nedre"
                          value={row.referenceLow ?? ""}
                          onChange={(e) =>
                            edit(i, {
                              referenceLow:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            })
                          }
                        />
                        <input
                          aria-label={`Övre referens analys ${i + 1}`}
                          type="number"
                          step="any"
                          placeholder="Övre"
                          value={row.referenceHigh ?? ""}
                          onChange={(e) =>
                            edit(i, {
                              referenceHigh:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            })
                          }
                        />
                      </div>
                    </label>
                    <label className="full">
                      Referenstext från laboratoriet, vid behov
                      <input
                        maxLength={300}
                        value={row.referenceText}
                        onChange={(e) =>
                          edit(i, { referenceText: e.target.value })
                        }
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={rows.length >= 100}
              onClick={() =>
                setRows([
                  ...rows,
                  newObservation(
                    catalog.find((c) => !rows.some((r) => r.code === c.code))
                      ?.code || "tsh",
                  ),
                ])
              }
            >
              <Plus size={15} />
              Lägg till analys
            </button>
            <p className="footnote">
              Kontrollera enheten mot originalsvaret. Systemet gör ingen
              automatisk enhetskonvertering.
            </p>
          </>
        ) : kind === "vaccination" ? (
          <div className="form-grid">
            <label>
              Vaccin
              <input
                required
                value={vaccine}
                onChange={(e) => setVaccine(e.target.value)}
                maxLength={120}
              />
            </label>
            <label>
              Dos / dosbeskrivning
              <input
                required
                value={dose}
                onChange={(e) => setDose(e.target.value)}
                maxLength={80}
              />
            </label>
            <label>
              Batchnummer, om känt
              <input
                value={batch}
                onChange={(e) => setBatch(e.target.value)}
                maxLength={80}
              />
            </label>
            <label>
              Vaccinationsställe
              <input
                required
                value={place}
                onChange={(e) => setPlace(e.target.value)}
                maxLength={160}
              />
            </label>
          </div>
        ) : (
          <div className="form-grid">
            <label>
              Modalitet
              <select
                value={modality}
                disabled={saving}
                onChange={(e) => {
                  setModality(e.target.value as typeof modality);
                  if (e.target.value !== "CT") discardUpload();
                }}
              >
                {["CT", "MR", "US", "XR", "OTHER"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Kroppsdel
              <input
                required
                value={bodyPart}
                onChange={(e) => setBodyPart(e.target.value)}
                maxLength={120}
              />
            </label>
            <label className="full">
              Undersöknings-ID från bildtjänsten, om ansluten
              <input
                value={studyId}
                onChange={(e) => setStudyId(e.target.value)}
                maxLength={36}
              />
            </label>
            {canAttachCt && modality === "CT" && (
              <div className="full ct-archive-field">
                <label>
                  Bifoga DT-bilder (ZIP)
                  <input
                    ref={archiveInput}
                    type="file"
                    accept=".zip,application/zip"
                    disabled={saving}
                    aria-describedby="ct-archive-help"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      discardUpload(false);
                      setError("");
                      if (!file) return;
                      if (!/\.zip$/i.test(file.name) || file.size < 22 || file.size > CT_ARCHIVE_MAX_BYTES) {
                        event.target.value = "";
                        setError("Välj en ZIP-fil på högst 50 MB.");
                        return;
                      }
                      setArchiveFile(file);
                    }}
                  />
                </label>
                <p id="ct-archive-help" className="muted">En ZIP-fil med DICOM-, JPEG- eller PNG-bilder. Högst 50 MB.</p>
                {(archiveFile || archiveId) && (
                  <div className="ct-archive-selection">
                    <span>{archiveFile ? "Filen laddas upp när du sparar." : "ZIP-fil bifogad"}</span>
                    <button type="button" className="text-button" disabled={saving} onClick={() => {
                      discardUpload();
                      setArchiveId(undefined);
                    }}>Ta bort bilaga</button>
                  </div>
                )}
                {uploadProgress !== undefined && (
                  <div className="ct-archive-progress" role="status">
                    <progress aria-label="ZIP-uppladdning" value={uploadProgress} max={100} />
                    {uploadProgress < 100 ? `Laddar upp ZIP-filen… ${uploadProgress} %` : "Kontrollerar och sparar ZIP-filen…"}
                  </div>
                )}
              </div>
            )}
            <label className="full">
              Utlåtande
              <textarea
                required
                value={conclusion}
                onChange={(e) => setConclusion(e.target.value)}
                maxLength={8000}
              />
            </label>
          </div>
        )}
        <label>
          Kommentar som patienten får läsa
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={4000}
          />
        </label>
        {needsReason && (
          <label>
            Orsak till rättelsen
            <input
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={close} disabled={saving}>
            Avbryt
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? "Sparar…" : "Spara utkast"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function newObservation(code: string): Observation {
  const c = catalog.find((x) => x.code === code)!;
  return {
    code: c.code,
    name: c.name,
    value: "",
    comparator: "=",
    unit: c.unit,
    referenceLow: null,
    referenceHigh: null,
    referenceText: "",
  };
}

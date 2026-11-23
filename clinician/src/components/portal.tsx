"use client";
import { VitalsWorkspace } from "@/components/vitals-workspace";
import { ClinicianHome } from "@/components/clinician-home";
import { ConsultDialog } from "@/components/consult-dialog";
import { PatientMessages } from "@/components/patient-messages";
import { InboxView } from "@/components/inbox-view";
import { CalendarView } from "@/components/calendar-view";
import { RoleBadge } from "@/components/role-badge";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  CalendarDays,
  ClipboardCheck,
  CheckCircle2,
  RefreshCw,
  ClipboardList,
  Download,
  FileCheck2,
  FlaskConical,
  Heart,
  History,
  ImageIcon,
  Inbox,
  LayoutDashboard,
  Lock,
  LockKeyhole,
  MessageSquareText,
  MessagesSquare,
  Plus,
  Search,
  ShieldCheck,
  Stethoscope,
  Syringe,
  Users,
  UsersRound,
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
  type Vital,
  vitalKinds,
  vitalPageSize,
} from "@/lib/model";
import { demoDetail, demoHome, demoOtherPatients, demoPatients, demoPublish } from "@/lib/demo";
import { AdministrationWorkspace } from "@/components/administration";
import { PresetField } from "@/components/preset-field";
import { ImagingWorkspace } from "@/components/imaging-workspace";
import { LabBody } from "@/components/lab-body";
import { AttestationGrid, type PendingItem } from "@/components/attestation-grid";
import "./shell.css";
import "./portal-grid.css";
import {
  imagingBodyParts,
  qualitativeLabResults,
  registrationSources,
  registrationTitles,
  vaccinationLocations,
  vaccineChoices,
  vaccineDoseChoices,
} from "@/lib/registration-options";
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
  ["messages", "Meddelanden", MessageSquareText],
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
  const [view, setView] = useState<"home" | "inbox" | "calendar" | "patients" | "all" | "attest">("home"),
    [inboxWaiting, setInboxWaiting] = useState(demo ? 1 : 0),
    [consulting, setConsulting] = useState(false),
    [allPatients, setAllPatients] = useState<Patient[] | null>(null),
    [attest, setAttest] = useState<PendingItem[] | null>(null),
    [attestError, setAttestError] = useState(""),
    [attestLoading, setAttestLoading] = useState(false),
    [demoTick, setDemoTick] = useState(0),
    [review, setReview] = useState<{ patientId: string; recordId: string; kind: Kind } | null>(null);
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
      if (!menu?.open) return;
      if (e.type === "click" ? !menu.contains(e.target as Node) : (e as KeyboardEvent).key === "Escape")
        menu.open = false;
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
  async function search(e?: FormEvent) {
    e?.preventDefault();
    const token = ++listRequestId.current;
    setError("");
    setBusy(true);
    try {
      const everyone = view === "all";
      if (demo) {
        const matches = (everyone ? [...demoPatients, ...demoOtherPatients] : demoPatients).filter((p) =>
          `${p.display_name} ${p.identity_label}`.toLowerCase().includes(query.toLowerCase()),
        );
        if (everyone) setAllPatients(matches);
        else setPatients(matches);
      } else {
        const value = await api("clinical", { action: everyone ? "directory" : "list", query });
        if (token === listRequestId.current) (everyone ? setAllPatients : setPatients)(value);
      }
    } catch (e) {
      if (token === listRequestId.current) setError((e as Error).message);
    } finally {
      if (token === listRequestId.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (view === "all" && session) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, session]);
  const loadAttest = useCallback(async () => {
    if (!session) return;
    setAttestLoading(true);
    try {
      if (demo) {
        const drafts = demoPatients.flatMap((p) =>
          (demoCache.current.get(p.id) || demoDetail(p)).records
            .filter((r) => r.status === "draft" && !r.superseded_at)
            .map((r): PendingItem => ({
              id: r.id,
              patient_id: p.id,
              display_name: p.display_name,
              identity_label: p.identity_label,
              identity_verified: p.identity_verified,
              kind: r.kind,
              version: r.version,
              revision: r.revision,
              is_correction: !!r.replaces_id,
              created_at: r.created_at,
              created_by_name: session.name,
              payload: r.payload,
            })),
        );
        setAttest(drafts);
      } else setAttest(await api("clinical", { action: "attestations" }));
      setAttestError("");
    } catch (e) {
      setAttestError((e as Error).message);
    } finally {
      setAttestLoading(false);
    }
  }, [demo, session]);
  useEffect(() => {
    // Inbox badge: the cheap unaudited check, every 15 s while the page is visible.
    if (demo || !session) return;
    let active = true;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await api("clinical", { action: "inbox", op: "poll" });
        if (active) setInboxWaiting(r.waiting ?? 0);
      } catch {
        // Retried on the next tick.
      }
    };
    void check();
    const timer = setInterval(() => void check(), 15000);
    document.addEventListener("visibilitychange", check);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [demo, session]);
  useEffect(() => {
    void loadAttest();
    const refresh = () => void loadAttest();
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 60000);
    return () => {
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [loadAttest, demoTick]);
  useEffect(() => {
    // Opening an item from the queue: jump to its tab and, for doctors, straight into review.
    if (!review || !detail || detail.patient.id !== review.patientId) return;
    const record = detail.records.find((r) => r.id === review.recordId);
    setTab(review.kind);
    if (record && record.status === "draft" && session?.role === "doctor") setPublishing(record);
    setReview(null);
  }, [review, detail, session]);
  async function open(patient: Patient, target: Tab = "overview") {
    const token = ++requestId.current;
    setDetail(null);
    setEditor(null);
    setTab(target);
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
    void loadAttest();
  }
  function storeDemo(data: PatientDetail) {
    demoCache.current.set(data.patient.id, data);
    setDemoTick((t) => t + 1);
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
  async function annul(reason: string) {
    if (!detail || !editor?.record) return;
    const token = requestId.current;
    const target = editor.record;
    if (demo) {
      storeDemo({
        ...detail,
        records: detail.records.filter((x) => x.id !== target.id),
        audit: [{ action: "Undersökning borttagen", created_at: new Date().toISOString() }, ...detail.audit],
      });
    } else {
      await api("clinical", { action: "annul", recordId: target.id, reason, confirm: "Ta bort" });
      if (token === requestId.current) void reload(detail.patient.id, token).catch(() => undefined);
    }
    if (token !== requestId.current) return;
    setEditor(null);
    setNotice("Undersökningen är borttagen.");
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
  const rows = view === "all" ? (allPatients ?? []) : patients;
  // Doctors open every patient in the clinic; nurses need an assignment.
  const locked = (p: Patient) => (p.can_open === undefined ? p.assigned_to_me === false : !p.can_open);
  const closeDetail = () => {
    requestId.current++;
    setDetail(null);
    setEditor(null);
    setPublishing(null);
    setBusy(false);
  };
  const records = detail?.records.filter((x) => !x.superseded_at) || [],
    published = records.filter((x) => x.status === "published"),
    drafts = records.filter((x) => x.status === "draft");
  return (
    <div className="workspace clinical-workspace">
      <header className="admin-topbar">
        <a className="admin-brand" href={demo ? "/demo" : links.clinical}>
          <span className="brand-mark">
            <Heart size={18} />
          </span>
          <span>
            Go<span>Health</span>
            <i>.</i>
          </span>
        </a>
        <span className="admin-crumb-sep">/</span>
        <span className="admin-org">Vårdteam</span>
        <span className="admin-pill">
          <LockKeyhole size={11} /> Skyddad
        </span>
        <form
          className="admin-search"
          role="search"
          onSubmit={(e) => {
            requestId.current++;
            setDetail(null);
            setEditor(null);
            setPublishing(null);
            void search(e);
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
        <div className="topbar-user">
          <span className="topbar-user-label">Inloggad som:</span>
          <strong>{session.name}</strong>
          <RoleBadge role={session.role} />
          {session.admin && (
            <a className="topbar-user-admin" href={demo ? "/demo/admin" : links.administration}>
              <ShieldCheck size={15} />
              Administration
            </a>
          )}
        </div>
      </header>
      <aside className="sidebar admin-rail">
        <nav id="clinical-navigation" aria-label="Vårdportalens meny">
          <button
            className={"nav-item" + (view === "home" ? " selected" : "")}
            aria-label="Översikt"
            onClick={() => {
              setView("home");
              closeDetail();
            }}
          >
            <LayoutDashboard size={17} />
            <span className="nav-label">Översikt</span>
          </button>
          <button
            className={"nav-item" + (view === "inbox" ? " selected" : "")}
            aria-label={`Inkorg (${inboxWaiting} väntar på svar)`}
            onClick={() => {
              setView("inbox");
              closeDetail();
            }}
          >
            <Inbox size={17} />
            <span className="nav-label">Inkorg</span>
            {inboxWaiting > 0 && <span className="nav-count alert">{inboxWaiting}</span>}
          </button>
          <button
            className={"nav-item" + (view === "calendar" ? " selected" : "")}
            aria-label="Kalender"
            onClick={() => {
              setView("calendar");
              closeDetail();
            }}
          >
            <CalendarDays size={17} />
            <span className="nav-label">Kalender</span>
          </button>
          <button
            className={"nav-item" + (view === "patients" ? " selected" : "")}
            aria-label={`Mina patienter (${patients.length})`}
            onClick={() => {
              setView("patients");
              setQuery("");
              closeDetail();
            }}
          >
            <Users size={17} />
            <span className="nav-label">Mina patienter</span>
            <span className="nav-count">{patients.length}</span>
          </button>
          <button
            className={"nav-item" + (view === "all" ? " selected" : "")}
            aria-label="Alla patienter"
            onClick={() => {
              setView("all");
              setQuery("");
              closeDetail();
            }}
          >
            <UsersRound size={17} />
            <span className="nav-label">Alla patienter</span>
            {allPatients && <span className="nav-count">{allPatients.length}</span>}
          </button>
          <button
            className={"nav-item" + (view === "attest" ? " selected" : "")}
            aria-label={`Attestering (${attest?.length ?? 0})`}
            onClick={() => {
              setView("attest");
              closeDetail();
              void loadAttest();
            }}
          >
            <ClipboardCheck size={17} />
            <span className="nav-label">Attestering</span>
            {!!attest?.length && <span className="nav-count alert">{attest.length}</span>}
          </button>
        </nav>
      </aside>
      <div className="main-shell">
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
              <div className="wb-tabs" role="tablist" aria-label="Öppna vyer">
                <button
                  role="tab"
                  aria-selected={!detail}
                  className={!detail ? "active" : ""}
                  onClick={closeDetail}
                >
                  {view === "home" ? <LayoutDashboard size={15} /> : view === "inbox" ? <Inbox size={15} /> : view === "calendar" ? <CalendarDays size={15} /> : view === "attest" ? <ClipboardCheck size={15} /> : view === "all" ? <UsersRound size={15} /> : <Users size={15} />}
                  {view === "home" ? "Översikt" : view === "inbox" ? "Inkorg" : view === "calendar" ? "Kalender" : view === "attest" ? "Attestering" : view === "all" ? "Alla patienter" : "Mina patienter"}
                </button>
                {detail && (
                  <span role="tab" aria-selected className="active wb-patient-tab">
                    <span className="wb-avatar">{initialsOf(detail.patient.display_name)}</span>
                    {detail.patient.display_name}
                    <button aria-label="Stäng patient" onClick={closeDetail}>
                      <X size={14} />
                    </button>
                  </span>
                )}
              </div>
          {!detail && view === "home" ? (
            <ClinicianHome
              demo={demo}
              name={session.name}
              demoData={demoHome()}
              onOpenPatient={(p, target) => {
                const known = [...demoPatients, ...demoOtherPatients, ...patients, ...(allPatients ?? [])].find((x) => x.id === p.id);
                void open(known ?? { id: p.id, display_name: p.display_name, identity_label: "", identity_verified: true, last_sync_at: null }, target);
              }}
              onAttest={() => {
                setView("attest");
                void loadAttest();
              }}
              onMyPatients={() => setView("patients")}
              onInbox={() => setView("inbox")}
            />
          ) : !detail && view === "inbox" ? (
            <InboxView
              demo={demo}
              authorName={session.name}
              onWaiting={setInboxWaiting}
              onCalendar={() => setView("calendar")}
              onOpenPatient={(p) => {
                const known = [...demoPatients, ...demoOtherPatients, ...patients, ...(allPatients ?? [])].find((x) => x.id === p.id);
                void open(known ?? { id: p.id, display_name: p.display_name, identity_label: "", identity_verified: true, last_sync_at: null });
              }}
            />
          ) : !detail && view === "calendar" ? (
            <CalendarView
              demo={demo}
              onOpenPatient={(p) => {
                const known = [...demoPatients, ...demoOtherPatients, ...patients, ...(allPatients ?? [])].find((x) => x.id === p.id);
                void open(known ?? { id: p.id, display_name: p.display_name, identity_label: "", identity_verified: true, last_sync_at: null }, "messages");
              }}
            />
          ) : !detail && view === "attest" ? (
            <AttestationGrid
              items={attest}
              loading={attestLoading}
              error={attestError}
              isDoctor={session.role === "doctor"}
              onRefresh={() => void loadAttest()}
              onReview={(item) => {
                setReview({ patientId: item.patient_id, recordId: item.id, kind: item.kind });
                void open({
                  id: item.patient_id,
                  display_name: item.display_name,
                  identity_label: item.identity_label,
                  identity_verified: item.identity_verified,
                  last_sync_at: null,
                });
              }}
            />
          ) : !detail ? (
            <div className="grid-view">
              <div className="grid-toolbar">
                <form className="grid-filter" onSubmit={search}>
                  <Search size={16} />
                  <input
                    aria-label="Filtrera patienter"
                    placeholder="Filtrera på namn eller exakt personnummer…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    maxLength={120}
                  />
                </form>
                <button
                  className="grid-btn"
                  type="button"
                  disabled={busy}
                  aria-label="Uppdatera"
                  onClick={() => void search()}
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              <div className="grid-scroll">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Patient <i>text</i></th>
                      <th>Personnummer <i>text</i></th>
                      <th>Identitet <i>status</i></th>
                      <th>Tilldelad läkare <i>text</i></th>
                      <th>Senaste datasynk <i>tid</i></th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id} className={locked(p) ? "is-locked" : ""} title={locked(p) ? "Patienten behöver vara tilldelad dig för att journalen ska kunna öppnas" : undefined} onClick={() => !locked(p) && open(p)}>
                        <td>
                          <button className="patient-link" disabled={locked(p)} onClick={(e) => { e.stopPropagation(); void open(p); }}>
                            <span className="patient-avatar">{initialsOf(p.display_name)}</span>
                            <strong>{p.display_name}</strong>
                          </button>
                        </td>
                        <td>{p.identity_label}</td>
                        <td>
                          <span className={"grid-chip " + (p.identity_verified ? "ok" : "warn")}>
                            {p.identity_verified ? "Verifierad" : "Kontroll återstår"}
                          </span>
                        </td>
                        <td>{p.doctors?.length ? p.doctors.join(", ") : "-"}</td>
                        <td>
                          {p.last_sync_at ? (
                            timestamp(p.last_sync_at)
                          ) : (
                            <span className="muted">Ingen synk ännu</span>
                          )}
                        </td>
                        <td className="grid-open">
                          {locked(p) ? (
                            <Lock size={15} aria-label="Kräver tilldelning" />
                          ) : (
                            <ArrowRight size={16} aria-label={`Öppna ${p.display_name}`} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!rows.length && (
                  <Empty
                    title="Inga patienter att visa"
                    description={view === "all" ? "Inga patienter matchar sökningen." : "En administratör behöver koppla ditt personalkonto till verifierade patienter."}
                  />
                )}
              </div>
              <div className="grid-footer">
                <span>Sida 1 av 1</span>
                <span>
                  {view === "all" ? "Tilldelning ändras i administrationsportalen · " : ""}
                  {rows.length} {rows.length === 1 ? "patient" : "patienter"}
                </span>
              </div>
            </div>
          ) : (
            <>
              <div className="patient-heading">
                <div className="patient-avatar large">
                  {detail.patient.display_name
                    .split(" ")
                    .map((x) => x[0])
                    .slice(0, 2)
                    .join("")}
                </div>
                <div>
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
                  <div className="overview-actions">
                    <button className="button secondary" onClick={() => setTab("messages")}>
                      <MessageSquareText size={16} />
                      Skicka meddelande
                    </button>
                    <button className="button secondary" onClick={() => setConsulting(true)}>
                      <MessagesSquare size={16} />
                      Konsultera med en kollega
                    </button>
                  </div>
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
                      label="Delade mätkategorier"
                      value={String(new Set(detail.vitals.map((vital) => vital.kind)).size)}
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
              ) : tab === "messages" ? (
                <PatientMessages
                  key={detail.patient.id}
                  patientId={detail.patient.id}
                  patientName={detail.patient.display_name}
                  demo={demo}
                  authorName={session.name}
                  onCalendar={() => {
                    setView("calendar");
                    closeDetail();
                  }}
                />
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
                <VitalsWorkspace key={detail.patient.id} detail={detail} demo={demo}
                  onRefresh={() => reload(detail.patient.id, requestId.current)} />
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
                        Bifoga bilder (DICOM, JPEG eller PNG) som en ZIP-fil när du registrerar ett utlåtande.
                        Patienten kan öppna bilderna i GoHealth när du publicerar utlåtandet.
                      </p>
                    </div>
                  )}
                  {tab === "lab" && (
                    <LabBody records={detail.records} identity={detail.patient.identity_label} />
                  )}
                  {tab === "imaging" ? (
                    <ImagingWorkspace
                      records={records}
                      demo={demo}
                      canRemove={(r) => r.status === "draft" || session.role === "doctor"}
                      onChanged={() => reload(detail.patient.id, requestId.current)}
                      renderReport={(r) => (
                        <RecordCard
                          record={r}
                          hideArchive
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
                      )}
                    />
                  ) : records.filter((x) => x.kind === tab).length ? (
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
      {consulting && detail && (
        <ConsultDialog
          patient={detail.patient}
          records={detail.records}
          demo={demo}
          onClose={() => setConsulting(false)}
          onSent={(colleague) => {
            setConsulting(false);
            setNotice(`Konsultationen har skickats till ${colleague}.`);
          }}
        />
      )}
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
          onAnnul={editor.record && (editor.record.status === "draft" || session.role === "doctor") ? annul : undefined}
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

function initialsOf(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?"
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
  hideArchive,
}: {
  record: ClinicalRecord;
  onEdit?: () => void;
  onPublish?: () => void;
  canPublish?: boolean;
  hideArchive?: boolean;
}) {
  return (
    <article className="record">
      <div className="record-top">
        <div>
          <span
            className={`pill ${r.status === "draft" ? "draft" : "published"}`}
          >
            {r.annulled_at
              ? "Borttagen"
              : r.superseded_at
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
          {r.payload.archiveId && !hideArchive && <CtArchiveDownload recordId={r.id} />}
        </>
      )}
      {r.payload.comment && <p className="comment">{r.payload.comment}</p>}
      {r.correction_reason && (
        <p className="muted">Rättelseorsak: {r.correction_reason}</p>
      )}
      {r.annulled_at && (
        <p className="muted">Orsak till borttagning: {r.annulment_reason}</p>
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
      link.download = "bilder.zip";
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
        <Download size={15} /> {downloading ? "Hämtar…" : "Hämta bilder (ZIP)"}
      </button>
      {error && <p role="alert" className="alert error">{error}</p>}
    </div>
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
      <section className="auth-story" aria-label="GoHealth">
        <Brand />
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
  onAnnul,
}: {
  kind: Kind;
  patient: Patient;
  record?: ClinicalRecord;
  correction?: boolean;
  canAttachCt: boolean;
  onClose: () => void;
  onSave: (payload: unknown, reason: string) => Promise<void>;
  onAnnul?: (reason: string) => Promise<void>;
}) {
  const [removing, setRemoving] = useState(false),
    [removeReason, setRemoveReason] = useState(""),
    [removeWord, setRemoveWord] = useState("");
  const p = record?.payload;
  const recordedTime = p ? new Date(p.sampledAt) : undefined;
  const recordedLocalTime = recordedTime
    ? new Date(recordedTime.getTime() - recordedTime.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : "";
  const [title, setTitle] = useState(p?.title || registrationTitles[kind][0]),
    [source, setSource] = useState(p?.source || ""),
    [recordDate, setRecordDate] = useState(recordedLocalTime.slice(0, 10)),
    [recordTime, setRecordTime] = useState(recordedLocalTime.slice(11)),
    [comment, setComment] = useState(p?.comment || ""),
    [reason, setReason] = useState(record?.correction_reason || ""),
    [rows, setRows] = useState<Observation[]>(
      p?.observations || [newObservation("tsh")],
    ),
    [vaccine, setVaccine] = useState(p?.vaccine || ""),
    [dose, setDose] = useState(p?.dose || ""),
    [batch, setBatch] = useState(p?.batch || ""),
    [place, setPlace] = useState(p?.location || ""),
    [modality, setModality] = useState<NonNullable<Payload["modality"]> | "">(p?.modality || ""),
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
  const dateInput = useRef<HTMLInputElement>(null);
  const needsReason = correction || !!record?.replaces_id;
  const eventName = { lab: "Provtagning", vaccination: "Vaccination", imaging: "Undersökning" }[kind];
  const nextAnalysis = catalog.find((analysis) => !rows.some((row) => row.code === analysis.code));
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
      const selectedLocalTime = `${recordDate}T${recordTime}`;
      const base = {
        title,
        source,
        sampledAt: p && selectedLocalTime === recordedLocalTime
          ? p.sampledAt
          : parseLocalDateTime(selectedLocalTime),
        comment,
      };
      const payload =
        kind === "lab"
          ? { ...base, observations: rows }
          : kind === "vaccination"
            ? { ...base, vaccine, dose, batch, location: place }
            : { ...base, modality, bodyPart, conclusion, studyId, archiveId: modality ? archiveId : undefined };
      const validated = validatePayload(kind, payload);
      if (kind === "imaging" && modality && archiveFile) {
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
      await onSave(validated, reason);
    } catch (e) {
      if (e instanceof ClinicalDateError) dateInput.current?.focus();
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
            {`${eventName}sdatum`}
            <input
              ref={dateInput}
              type="date"
              required
              value={recordDate}
              onChange={(e) => setRecordDate(e.target.value)}
            />
          </label>
          <label>
            {`${eventName}stid`}
            <input
              type="time"
              required
              value={recordTime}
              onChange={(e) => setRecordTime(e.target.value)}
            />
          </label>
          <PresetField label="Titel" value={title} onChange={setTitle}
            options={registrationTitles[kind]} otherLabel="Egen titel" maxLength={160} />
          <PresetField label={kind === "lab" ? "Laboratorium / originalkälla" : "Uppgifternas källa"}
            value={source} onChange={setSource} options={registrationSources[kind]}
            placeholder="Välj källa" otherLabel="Annan källa" maxLength={160} />
        </div>
        {kind === "lab" ? (
          <>
            <div className="editor-rows">
              {rows.map((row, i) => (
                <div className="editor-row" key={row.code}>
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
                        {catalog.filter((c) => c.code === row.code || !rows.some((r) => r.code === c.code)).map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <PresetField key={row.comparator === "text" ? "qualitative" : "numeric"}
                      label="Enhet" value={row.unit} onChange={(unit) => edit(i, { unit })}
                      options={catalog.filter((c) => c.code === row.code).map((c) => c.unit)}
                      placeholder={row.comparator === "text" ? "Ingen enhet" : "Välj enhet"}
                      otherLabel="Annan enhet" maxLength={80} required={row.comparator !== "text"} />
                    <label>
                      Resultattyp
                      <select
                        aria-label={`Resultattyp analys ${i + 1}`}
                        value={row.comparator}
                        onChange={(e) => {
                          const comparator = e.target.value as Observation["comparator"];
                            if ((comparator === "text") !== (row.comparator === "text")) {
                              const unit = comparator === "text" ? "" : newObservation(row.code).unit;
                              edit(i, { comparator, value: "", unit });
                            } else {
                              edit(i, { comparator });
                            }
                        }}
                      >
                        {["=", "<", ">", "<=", ">=", "text"].map((x) => (
                          <option key={x} value={x}>{x === "text" ? "Kvalitativt svar" : x}</option>
                        ))}
                      </select>
                    </label>
                    {row.comparator === "text" ? (
                      <PresetField label="Resultat" value={row.value} onChange={(value) => edit(i, { value })}
                        options={qualitativeLabResults} otherLabel="Annat svar" maxLength={120} />
                    ) : (
                      <label>
                        Resultat
                        <input
                          aria-label={`Resultat analys ${i + 1}`}
                          inputMode="decimal"
                          pattern="-?[0-9]+([.,][0-9]+)?"
                          required
                          value={row.value}
                          onChange={(e) => edit(i, { value: e.target.value.replace(",", ".") })}
                          maxLength={120}
                        />
                      </label>
                    )}
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
              disabled={!nextAnalysis}
              onClick={() => {
                if (nextAnalysis) setRows([...rows, newObservation(nextAnalysis.code)]);
              }}
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
            <PresetField label="Vaccin" value={vaccine} onChange={(value) => {
              setVaccine(value);
              setDose("");
            }} options={vaccineChoices} placeholder="Välj vaccin" otherLabel="Annat vaccin" maxLength={120} />
            <PresetField key={vaccine} label="Dos" value={dose} onChange={setDose}
              options={vaccineDoseChoices(vaccine)} placeholder={vaccine.trim() ? "Välj dos" : "Välj vaccin först"}
              otherLabel="Annan dos" maxLength={80} disabled={!vaccine.trim()} />
            <label>
              Batchnummer, om känt
              <input
                value={batch}
                onChange={(e) => setBatch(e.target.value)}
                maxLength={80}
              />
            </label>
            <PresetField label="Vaccinationsställe" value={place} onChange={setPlace}
              options={vaccinationLocations} otherLabel="Annat vaccinationsställe" maxLength={160} />
          </div>
        ) : (
          <div className="form-grid">
            <label>
              Modalitet
              <select
                value={modality}
                required
                disabled={saving}
                onChange={(e) => {
                  setModality(e.target.value as typeof modality);
                }}
              >
                <option value="" disabled>Välj undersökningstyp</option>
                <option value="CT">Datortomografi (DT/CT)</option>
                <option value="MR">Magnetkamera (MR)</option>
                <option value="US">Ultraljud (UL)</option>
                <option value="XR">Konventionell röntgen</option>
                <option value="OTHER">Annan modalitet</option>
              </select>
            </label>
            <PresetField label="Kroppsdel" value={bodyPart} onChange={setBodyPart}
              options={imagingBodyParts} otherLabel="Annan kroppsdel" maxLength={120} />
            <label className="full">
              Undersöknings-ID från bildtjänsten, om ansluten
              <input
                value={studyId}
                onChange={(e) => setStudyId(e.target.value)}
                maxLength={36}
              />
            </label>
            {canAttachCt && modality && (
              <div className="full ct-archive-field">
                <label>
                  Bifoga bilder (ZIP)
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
        {removing && record && onAnnul && (
          <div className="remove-panel" role="alertdialog" aria-label="Bekräfta borttagning">
            <strong>Ta bort undersökningen</strong>
            <p>
              Utlåtandet{record.payload.archiveId ? " och bilderna" : ""} tas bort från journalen och försvinner för patienten.
              En spärrad kopia med orsaken sparas i loggen. Det går inte att ångra.
            </p>
            <label>
              Orsak
              <input
                value={removeReason}
                maxLength={500}
                onChange={(e) => setRemoveReason(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              />
            </label>
            <label>
              <span>Skriv <b>Ta bort</b> för att bekräfta</span>
              <input
                value={removeWord}
                autoComplete="off"
                onChange={(e) => setRemoveWord(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              />
            </label>
            <div className="remove-actions">
              <button type="button" className="button secondary" disabled={saving} onClick={() => {
                setRemoving(false);
                setRemoveReason("");
                setRemoveWord("");
              }}>
                Avbryt
              </button>
              <button
                type="button"
                className="button danger-fill"
                disabled={saving || removeWord !== "Ta bort" || !removeReason.trim()}
                onClick={async () => {
                  setSaving(true);
                  setError("");
                  try {
                    discardUpload();
                    await onAnnul(removeReason.trim());
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Undersökningen kunde inte tas bort.");
                    setSaving(false);
                  }
                }}
              >
                Ta bort undersökningen
              </button>
            </div>
          </div>
        )}
        <div className="dialog-actions">
          {record && onAnnul && (
            <button type="button" className="button danger" onClick={() => {
              setRemoving(true);
              setTimeout(() => document.querySelector(".remove-panel")?.scrollIntoView({ block: "center", behavior: "smooth" }), 30);
            }} disabled={saving || removing}>
              Ta bort
            </button>
          )}
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

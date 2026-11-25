"use client";
import { ArrowDownWideNarrow, Check, Copy, Mail, Pencil, Phone, RefreshCw, Search, UsersRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { RoleBadge } from "@/components/role-badge";
import { roleNames, type StaffRole } from "@/lib/administration";
import {
  FULL_LIST, initials, matchesColleague, sortColleagues, telHref, validPhone, workloadLevel, workloadShare,
  type Colleague, type ColleagueSort,
} from "@/lib/colleagues";
import "./colleagues-view.css";

async function post(body: unknown) {
  const r = await fetch("/api/clinical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Kollegorna kunde inte hämtas.");
  return data;
}

const roleName = (role: string) => (role in roleNames ? roleNames[role as StaffRole] : "Vårdpersonal");

function demoColleagues(): Colleague[] {
  const c = (id: number, name: string, role: string, phone: string | null, extra: Partial<Colleague> = {}): Colleague => ({
    id: `00000000-0000-4000-9000-${String(id).padStart(12, "0")}`, organization: "GoHealth Demo", name, role,
    email: name.toLowerCase().replace(/^dr\.\s*/, "").normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, ".") + "@gohealth.example",
    phone, self: false, patients: null, teamSize: null, team: null, ...extra,
  });
  return [
    c(1, "Dr. Sofia Lind", "doctor", "070-174 06 05", { patients: 72, teamSize: 3, self: true }),
    c(2, "Dr. Erik Dahl", "doctor", "070-174 06 06", { patients: 104, teamSize: 2 }),
    c(3, "Dr. Amir Nasser", "doctor", null, { patients: 51, teamSize: 1 }),
    c(4, "Dr. Emma Berg", "doctor", "070-174 06 08", { patients: 23, teamSize: 0 }),
    c(5, "Anna Holm", "nurse", "070-174 06 09", { team: "Dr. Sofia Lind" }),
    c(6, "Johan Ek", "nurse", "070-174 06 10", { team: "Dr. Erik Dahl" }),
    c(7, "Karin Nyström", "nurse", null, { team: "Dr. Sofia Lind" }),
    c(8, "Maria Sjöberg", "psychologist", "070-174 06 12", { team: "Dr. Sofia Lind" }),
    c(9, "Lena Åberg", "secretary", "070-174 06 13", { team: "Dr. Erik Dahl" }),
    c(10, "Petra Lund", "nurse", "070-174 06 14", { team: "Dr. Amir Nasser" }),
    c(11, "Oskar Wall", "nurse", null),
  ];
}

type Open = { id: string; kind: "mail" | "phone" } | null;

/** "Kollegor": everyone in the clinic, with e-mail and phone for internal contact, doctors' workload and teams. */
export function ColleaguesView({ demo }: { demo: boolean }) {
  const [list, setList] = useState<Colleague[] | null>(demo ? demoColleagues() : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<string>("all");
  const [sort, setSort] = useState<ColleagueSort>("role");
  const [open, setOpen] = useState<Open>(null);
  const [grown, setGrown] = useState(false);

  const load = useCallback(async () => {
    if (demo) return;
    setBusy(true);
    try {
      setList(((await post({ action: "colleagues" })) as { colleagues: Colleague[] }).colleagues);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [demo]);
  useEffect(() => { void load(); }, [load]);

  // The bars grow in once the list is there.
  useEffect(() => {
    if (!list) return;
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, [list]);

  const me = list?.find((c) => c.self) ?? null;
  const clinics = new Set(list?.map((c) => c.organization)).size;
  const roles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of list ?? []) counts.set(c.role, (counts.get(c.role) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => ["doctor", "nurse", "psychologist", "secretary"].indexOf(a) - ["doctor", "nurse", "psychologist", "secretary"].indexOf(b));
  }, [list]);
  const shown = useMemo(
    () => sortColleagues((list ?? []).filter((c) => (role === "all" || c.role === role) && matchesColleague(c, query, roleName(c.role))), sort),
    [list, role, query, sort],
  );
  const doctors = (list ?? []).filter((c) => c.role === "doctor");
  const full = doctors.filter((c) => (c.patients ?? 0) >= FULL_LIST).length;

  async function savePhone(phone: string) {
    const cleaned = phone.trim();
    if (demo) {
      setList((l) => l?.map((c) => (c.self ? { ...c, phone: cleaned || null } : c)) ?? l);
      return;
    }
    const result = (await post({ action: "set_phone", phone: cleaned })) as { phone: string | null };
    setList((l) => l?.map((c) => (c.self ? { ...c, phone: result.phone } : c)) ?? l);
  }

  return (
    <section className="col" aria-labelledby="col-title">
      <header className="col-head">
        <div>
          <h1 id="col-title">Kollegor</h1>
          <p>Hela vårdteamet på ett ställe. Mejla eller ring för intern kontakt.</p>
        </div>
        {list && (
          <div className="col-stats" aria-label="Sammanfattning">
            <span><b>{list.length}</b> kollegor</span>
            <span><b>{doctors.length}</b> läkare</span>
            <span className={full ? "is-alert" : ""}><b>{full}</b> med full lista</span>
          </div>
        )}
      </header>

      {me && !me.phone && <PhoneNudge onSave={savePhone} />}

      <div className="col-toolbar">
        <label className="col-search">
          <Search size={16} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Sök namn, team, roll eller e-post" aria-label="Sök kollega" />
          {query && (
            <button type="button" aria-label="Rensa sökningen" onClick={() => setQuery("")}><X size={14} /></button>
          )}
        </label>
        <div className="col-filters" role="group" aria-label="Filtrera på roll">
          <button type="button" aria-pressed={role === "all"} className={role === "all" ? "is-on" : ""} onClick={() => setRole("all")}>
            Alla <span>{list?.length ?? 0}</span>
          </button>
          {roles.map(([r, n]) => (
            <button key={r} type="button" aria-pressed={role === r} className={role === r ? "is-on" : ""} onClick={() => setRole(r)}>
              <i className={`col-dot role-${r in roleNames ? r : "other"}`} aria-hidden />
              {roleName(r)} <span>{n}</span>
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="alert error col-error">
          {error}
          <button type="button" onClick={() => void load()}><RefreshCw size={14} /> Försök igen</button>
        </div>
      )}

      <div className="col-table" role="table" aria-label="Kollegor" aria-busy={busy}>
        <div className="col-row col-header" role="row">
          <div role="columnheader">
            <button type="button" className={sort === "name" ? "is-on" : ""} onClick={() => setSort(sort === "name" ? "role" : "name")}>
              Namn {sort === "name" && <ArrowDownWideNarrow size={13} aria-hidden />}
            </button>
          </div>
          <div role="columnheader">Behörighet</div>
          <div role="columnheader" className="col-center">Kontakt</div>
          <div role="columnheader">
            <button type="button" className={sort === "workload" ? "is-on" : ""} onClick={() => setSort(sort === "workload" ? "role" : "workload")}
              title="Läkare: tilldelade patienter, full lista vid 100. Övriga: läkarens team.">
              Patienter · team {sort === "workload" && <ArrowDownWideNarrow size={13} aria-hidden />}
            </button>
          </div>
        </div>

        {!list && !error && [0, 1, 2, 3].map((i) => (
          <div key={i} className="col-row col-skeleton" role="row" aria-hidden>
            <span /><span /><span /><span />
          </div>
        ))}

        {list && shown.length === 0 && (
          <div className="col-empty" role="row">
            <UsersRound size={22} aria-hidden />
            {list.length === 0 ? "Det finns inga kollegor att visa ännu." : "Ingen kollega matchar sökningen."}
          </div>
        )}

        {shown.map((c) => (
          <div key={`${c.organization}-${c.id}`} className={`col-row${c.self ? " is-self" : ""}`} role="row">
            <div role="cell" className="col-person">
              <span className={`col-avatar role-${c.role in roleNames ? c.role : "other"}`} aria-hidden>{initials(c.name)}</span>
              <span className="col-person-text">
                <strong>
                  {c.name}
                  {c.self && <em className="col-you">Du</em>}
                </strong>
                {clinics > 1 && <small>{c.organization}</small>}
              </span>
            </div>
            <div role="cell"><RoleBadge role={c.role} small /></div>
            <div role="cell" className="col-contact">
              <ContactButton
                kind="mail" person={c} open={open?.id === c.id && open.kind === "mail"}
                onToggle={(on) => setOpen(on ? { id: c.id, kind: "mail" } : null)}
              />
              <ContactButton
                kind="phone" person={c} open={open?.id === c.id && open.kind === "phone"}
                onToggle={(on) => setOpen(on ? { id: c.id, kind: "phone" } : null)}
                onSavePhone={c.self ? savePhone : undefined}
              />
            </div>
            <div role="cell" className="col-load">
              {c.role === "doctor" ? <Workload patients={c.patients ?? 0} teamSize={c.teamSize} grown={grown} /> : <Team team={c.team} />}
            </div>
          </div>
        ))}
      </div>
      <p className="col-foot">
        Grön under 50 patienter, gul från 50 och röd vid {FULL_LIST} eller fler. Team sätts av administratören.
      </p>
    </section>
  );
}

function Workload({ patients, teamSize, grown }: { patients: number; teamSize: number | null; grown: boolean }) {
  const level = workloadLevel(patients);
  const label = level === "full" ? "Full lista" : level === "busy" ? "Hög belastning" : "Har plats";
  return (
    <div className={`col-workload is-${level}`} title={`${patients} av ${FULL_LIST} patienter · ${label}`}>
      <div className="col-bar" role="meter" aria-valuemin={0} aria-valuemax={FULL_LIST} aria-valuenow={Math.min(patients, FULL_LIST)}
        aria-label={`${patients} patienter, ${label.toLowerCase()}`}>
        <span style={{ transform: `scaleX(${grown ? workloadShare(patients) : 0})` }} />
        <i aria-hidden />
      </div>
      <span className="col-count"><b>{patients}</b> patienter</span>
      {teamSize != null && teamSize > 0 && <small>{teamSize} i teamet</small>}
    </div>
  );
}

function Team({ team }: { team: string | null }) {
  if (!team) return <span className="col-noteam">Inget team</span>;
  return (
    <span className="col-team" title={`Tillhör ${team}s team`}>
      <span className="col-avatar is-small role-doctor" aria-hidden>{initials(team)}</span>
      <span><small>Team</small>{team}</span>
    </span>
  );
}

function ContactButton({ kind, person, open, onToggle, onSavePhone }: {
  kind: "mail" | "phone";
  person: Colleague;
  open: boolean;
  onToggle: (on: boolean) => void;
  onSavePhone?: (phone: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const value = kind === "mail" ? person.email : person.phone;
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(person.phone ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!open) { setEditing(false); setProblem(""); setCopied(false); return; }
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onToggle(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") onToggle(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape); };
  }, [open, onToggle]);

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* the value is selectable as a fallback */ }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!onSavePhone) return;
    if (draft.trim() && !validPhone(draft)) { setProblem("Ange numret med siffror, till exempel 070-123 45 67."); return; }
    setSaving(true);
    try {
      await onSavePhone(draft);
      setEditing(false);
      setProblem("");
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const Icon = kind === "mail" ? Mail : Phone;
  const title = kind === "mail" ? "E-post" : "Telefon";
  const missing = !value;
  const label = missing
    ? kind === "phone" && onSavePhone ? "Lägg till ditt telefonnummer" : `${person.name} har inget ${kind === "mail" ? "e-post" : "telefonnummer"} angivet`
    : `${title} till ${person.name}: ${value}`;

  return (
    <div className="col-contact-item" ref={ref}>
      <button type="button" className={`col-icon is-${kind}${missing ? " is-missing" : ""}${open ? " is-open" : ""}`}
        aria-label={label} title={label} aria-expanded={open} onClick={() => onToggle(!open)}>
        <Icon size={16} />
      </button>
      {open && (
        <div className="col-pop" role="dialog" aria-label={title}>
          <div className="col-pop-head">
            <Icon size={14} aria-hidden />
            <span>{title}</span>
            <button type="button" aria-label="Stäng" onClick={() => onToggle(false)}><X size={13} /></button>
          </div>
          {editing || (missing && onSavePhone && kind === "phone") ? (
            <form onSubmit={save} className="col-pop-form">
              <input autoFocus inputMode="tel" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="070-123 45 67" aria-label="Ditt jobbnummer" maxLength={30} />
              <button type="submit" className="primary" disabled={saving}>{saving ? "Sparar…" : "Spara"}</button>
              {problem && <p className="col-pop-problem" role="alert">{problem}</p>}
              <p className="col-pop-hint">Syns för dina kollegor i kliniken.</p>
            </form>
          ) : missing ? (
            <p className="col-pop-empty">{person.name} har inte lagt till något {kind === "mail" ? "e-post" : "nummer"} ännu.</p>
          ) : (
            <>
              <strong className="col-pop-value">{value}</strong>
              <div className="col-pop-actions">
                <a className="primary" href={kind === "mail" ? `mailto:${value}` : telHref(value!)}>
                  <Icon size={14} aria-hidden /> {kind === "mail" ? "Skicka e-post" : "Ring"}
                </a>
                <button type="button" onClick={() => void copy()}>
                  {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? "Kopierat" : "Kopiera"}
                </button>
                {kind === "phone" && onSavePhone && (
                  <button type="button" onClick={() => { setDraft(person.phone ?? ""); setEditing(true); }} aria-label="Ändra ditt nummer">
                    <Pencil size={14} aria-hidden />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PhoneNudge({ onSave }: { onSave: (phone: string) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!validPhone(draft)) { setProblem("Ange numret med siffror, till exempel 070-123 45 67."); return; }
    setSaving(true);
    try { await onSave(draft); } catch (err) { setProblem((err as Error).message); } finally { setSaving(false); }
  }
  return (
    <form className="col-nudge" onSubmit={submit}>
      <span className="col-nudge-icon" aria-hidden><Phone size={16} /></span>
      <div>
        <strong>Lägg till ditt jobbnummer</strong>
        <p>Då kan kollegor ringa dig direkt härifrån.</p>
        {problem && <p className="col-pop-problem" role="alert">{problem}</p>}
      </div>
      <input inputMode="tel" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="070-123 45 67" aria-label="Ditt jobbnummer" maxLength={30} />
      <button type="submit" className="primary" disabled={saving || !draft.trim()}>{saving ? "Sparar…" : "Spara"}</button>
    </form>
  );
}

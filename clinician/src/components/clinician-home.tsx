"use client";
import {
  Activity, ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardCheck, ExternalLink, FlaskConical, Megaphone,
  MessageSquareText, MessagesSquare, Newspaper, RefreshCw, Send, Undo2, Volume2, VolumeX, WifiOff, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { buildBriefing, followupsDue, type FocusTarget } from "@/lib/assistant";
import { addDays, stockholmDate, weekStart } from "@/lib/booking";
import type { HomeConsultation, HomeData, HomeDeviation, HomeMeeting } from "@/lib/clinician-home";
import type { NewsSource } from "@/lib/news";
import "./clinician-home.css";

async function post(body: unknown) {
  const r = await fetch("/api/clinical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Åtgärden kunde inte genomföras.");
  return data;
}
const zone = "Europe/Stockholm";
const time = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: zone });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: zone });
const day = (iso: string | null) =>
  iso ? new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short", timeZone: zone }) : "";
const kindLabel: Record<string, string> = { lab: "Provsvar", vaccination: "Vaccination", imaging: "Bilddiagnostik" };
const visitLabel: Record<string, string> = { video: "Video", phone: "Telefon", clinic: "Besök" };
const num = (n: number | undefined | null) => (n == null ? "–" : String(Math.round(n * 10) / 10).replace(".", ","));
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Types the briefing line by line, so the assistant appears to speak: once when the day's summary first arrives and
 * again when the assistant is poked. Later updates (a review, a background refresh) appear at once. No typing for
 * reduced motion.
 */
function useTypewriter(lines: string[], real: boolean, replay: number) {
  const [line, setLine] = useState(0);
  const [chars, setChars] = useState(0);
  const typedReal = useRef(false);
  const lastReplay = useRef(replay);
  const text = lines.join("\n");
  useEffect(() => {
    const poked = replay !== lastReplay.current;
    lastReplay.current = replay;
    if (reducedMotion() || (typedReal.current && !poked)) {
      setLine(lines.length);
      return;
    }
    if (real) typedReal.current = true;
    setLine(0);
    setChars(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, replay]);
  useEffect(() => {
    if (line >= lines.length) return;
    const full = lines[line].length;
    const t = setTimeout(() => {
      if (chars < full) setChars((c) => Math.min(full, c + 2));
      else { setLine((l) => l + 1); setChars(0); }
    }, chars < full ? 18 : 420);
    return () => clearTimeout(t);
  }, [line, chars, lines]);
  const shown = lines.map((l, i) => (i < line ? l : i === line ? l.slice(0, chars) : ""));
  return { shown, typing: line < lines.length, skip: () => setLine(lines.length) };
}

export function ClinicianHome({ demo, name, demoData, onOpenPatient, onAttest, onMyPatients, onInbox }: {
  demo: boolean;
  name: string;
  demoData: HomeData;
  onOpenPatient: (patient: { id: string; display_name: string }, tab?: "overview" | "messages" | "lab" | "vitals") => void;
  onAttest: () => void;
  onMyPatients: () => void;
  onInbox?: () => void;
}) {
  const [data, setData] = useState<HomeData | null>(demo ? demoData : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [news, setNews] = useState<NewsSource[] | null>(null);
  const [newsTab, setNewsTab] = useState("all");
  const [replay, setReplay] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [now] = useState(() => new Date());

  const load = useCallback(async (silent = false) => {
    if (demo) return;
    if (!silent) setBusy(true);
    try {
      setData(await post({ action: "overview" }));
      setError("");
    } catch (e) {
      // A failed background refresh keeps the current view; only a requested refresh reports the error.
      if (!silent) setError((e as Error).message);
    } finally {
      if (!silent) setBusy(false);
    }
  }, [demo]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 30000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);
  useEffect(() => {
    fetch("/api/news")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { sources: NewsSource[] }) => setNews(d.sources))
      .catch(() => setNews([]));
  }, []);
  useEffect(() => () => { if (typeof window !== "undefined") window.speechSynthesis?.cancel(); }, []);

  const briefing = useMemo(() => (data ? buildBriefing(data, name, now) : null), [data, name, now]);
  const { shown, typing, skip } = useTypewriter(briefing?.lines ?? ["Jag sammanställer din dag…"], !!briefing, replay);

  function speak() {
    const synth = window.speechSynthesis;
    if (!synth || !briefing) return;
    if (speaking) { synth.cancel(); setSpeaking(false); return; }
    const u = new SpeechSynthesisUtterance(`${briefing.greeting}. ${briefing.lines.join(" ")}`);
    u.lang = "sv-SE";
    u.rate = 1.02;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
  }
  function focusOn(target: FocusTarget) {
    const el = document.getElementById(`home-${target}`);
    if (!el) return;
    el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    el.classList.remove("is-flash");
    requestAnimationFrame(() => el.classList.add("is-flash"));
  }

  async function act(c: HomeConsultation, op: "reply" | "close", reply?: string) {
    if (demo) {
      setData((d) => d && {
        ...d,
        counts: { ...d.counts, consultations: Math.max(0, d.counts.consultations - (c.direction === "in" && c.status === "open" ? 1 : 0)) },
        consultations: op === "close" ? d.consultations.filter((x) => x.id !== c.id)
          : d.consultations.map((x) => (x.id === c.id ? { ...x, status: "answered", reply: reply ?? "", replied_at: new Date().toISOString() } : x)),
      });
      return;
    }
    await post({ action: "consultation", op, id: c.id, ...(reply ? { reply } : {}) });
    await load(true);
  }
  async function review(d: HomeDeviation, undo = false) {
    if (!d.key) return;
    const stamp = undo ? null : new Date().toISOString();
    const by = undo ? null : name.replace(/\s*\(.*\)\s*$/, "");
    setData((x) => x && {
      ...x,
      counts: { ...x.counts, review: Math.max(0, (x.counts.review ?? 0) + (undo ? 1 : -1)) },
      deviations: x.deviations.map((y) => (y.patient_id === d.patient_id && y.key === d.key ? { ...y, reviewed_at: stamp, reviewed_by: by } : y)),
    });
    if (demo) return;
    try {
      await post({ action: "review_deviation", patientId: d.patient_id, key: d.key, undo });
    } catch (e) {
      setError((e as Error).message);
    }
    void load(true);
  }

  const counts = data?.counts;
  const isDoctor = demo || data?.role === "doctor";
  const items = news?.flatMap((s) => s.items.map((i) => ({ ...i, source: s.source, name: s.name })))
    .filter((i) => newsTab === "all" || i.source === newsTab)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, newsTab === "all" ? 8 : 6);
  const today = stockholmDate(now);
  const todays = (data?.agenda ?? []).filter((m) => stockholmDate(new Date(m.starts_at)) === today);
  const toReview = (data?.deviations ?? []).filter((d) => !d.reviewed_at && d.category !== "sync");

  return (
    <section className="home" aria-label="Översikt">
      {/* The assistant: the largest part of the page. */}
      <section className={`ai-hero mood-${briefing?.mood ?? "calm"}`} aria-label="Dagens överblick">
        <div className="ai-aurora" aria-hidden="true"><i /><i /><i /></div>
        <div className="ai-stage">
          <AssistantAvatar mood={briefing?.mood ?? "calm"} talking={typing || speaking}
            onPoke={() => { window.speechSynthesis?.cancel(); setSpeaking(false); setReplay((r) => r + 1); }} />
          <span className="ai-name">GoHealth-assistenten</span>
        </div>
        <div className="ai-talk">
          <p className="ai-kicker">{now.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: zone })}</p>
          <h1>{briefing?.greeting ?? "Välkommen"}</h1>
          <div className="ai-bubble" aria-live="polite" onClick={skip}>
            {shown.map((l, i) => (l ? <p key={i}>{l}{typing && i === shown.findLastIndex((x) => x) && <span className="ai-caret" />}</p> : null))}
          </div>
          {briefing && briefing.focus.length > 0 && (
            <div className="ai-focus">
              {briefing.focus.map((f) => (
                <button key={f.target} className={"ai-chip " + f.tone} onClick={() => focusOn(f.target)}>
                  <b>{f.count}</b> {f.label} <ArrowRight size={13} />
                </button>
              ))}
            </div>
          )}
          <div className="ai-tools">
            <button onClick={speak} disabled={!briefing} aria-pressed={speaking}>
              {speaking ? <VolumeX size={14} /> : <Volume2 size={14} />} {speaking ? "Tysta" : "Läs upp"}
            </button>
            {!demo && (
              <button onClick={() => void load()} disabled={busy}>
                <RefreshCw size={14} className={busy ? "home-spin" : ""} /> Uppdatera
              </button>
            )}
            <span>Sammanställt i portalen av dagens data. Ingen extern AI, inga data lämnar systemet.</span>
          </div>
        </div>
        <aside className="ai-today" id="home-agenda">
          <h2><CalendarDays size={15} /> Idag</h2>
          {!data ? <p className="ai-muted">Hämtar…</p> : !todays.length ? (
            <p className="ai-muted">Inga bokade möten idag.</p>
          ) : (
            <ol className="ai-timeline">
              {todays.map((m) => (
                <li key={m.id} className={new Date(m.ends_at) < now ? "is-past" : ""}>
                  <time>{clock(m.starts_at)}</time>
                  <button onClick={() => onOpenPatient({ id: m.patient_id, display_name: m.display_name }, "messages")}>
                    <strong>{m.display_name}</strong><small>{visitLabel[m.visit_type]}</small>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="ai-stats">
            <button onClick={onMyPatients}><b>{counts?.assigned ?? "–"}</b><span>Mina patienter</span></button>
            <button onClick={() => focusOn("review")}><b>{counts?.review ?? toReview.length}</b><span>Att granska</span></button>
            <button onClick={() => focusOn("drafts")}><b>{counts?.unsigned ?? "–"}</b><span>Ej publicerade</span></button>
            <button onClick={onInbox}><b>{counts?.messages ?? "–"}</b><span>Meddelanden</span></button>
          </div>
        </aside>
      </section>
      {error && <div className="alert error" role="alert">{error}</div>}

      <div className="home-grid">
        <div className="home-col">
          <DeviationsCard data={data} isDoctor={isDoctor} onReview={review} onOpenPatient={onOpenPatient} />
          <FollowupCard data={data} now={now} onOpenPatient={onOpenPatient} />
          <Card id="home-messages" icon={<MessageSquareText size={18} />} title="Meddelanden från patienter" subtitle="Väntar på svar från vårdteamet"
            action={onInbox && <button className="home-link" onClick={onInbox}>Inkorg <ArrowRight size={14} /></button>}>
            {!data ? <Loading /> : !data.messages?.length ? (
              <p className="home-empty">Inga meddelanden väntar.</p>
            ) : (
              <ul className="home-list">
                {data.messages.map((m) => (
                  <li key={m.patient_id}>
                    <button className="home-row" onClick={() => onOpenPatient({ id: m.patient_id, display_name: m.display_name }, "messages")}>
                      <span className="home-dot warn" aria-hidden="true" />
                      <span className="home-row-main">
                        <strong>{m.display_name}{m.waiting > 1 ? ` · ${m.waiting} meddelanden` : ""}</strong>
                        <small className="home-preview">{m.body}</small>
                      </span>
                      <span className="home-row-meta">{time(m.created_at)}</span>
                      <ArrowRight size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {(data?.consultations.length ?? 0) > 0 && (
            <Card id="home-consultations" icon={<MessagesSquare size={18} />} title="Konsultationer" subtitle="Skickas från patientens översikt">
              <ul className="home-consults">
                {data!.consultations.map((c) => <ConsultItem key={c.id} c={c} onAct={act} onOpen={() => onOpenPatient({ id: c.patient_id, display_name: c.display_name })} />)}
              </ul>
            </Card>
          )}
        </div>

        <div className="home-col">
          <Card id="home-drafts" icon={<ClipboardCheck size={18} />} title="Osignerade ärenden" subtitle="Det som väntar på dig innan patienten ser det"
            action={<button className="home-link" onClick={onAttest}>Attestering <ArrowRight size={14} /></button>}>
            <h3 className="home-sub">Ej publicerade till patientappen <span>{data?.unsigned.length ?? 0}</span></h3>
            {!data ? <Loading /> : !data.unsigned.length ? (
              <p className="home-empty">Inga utkast väntar.</p>
            ) : (
              <ul className="home-list">
                {data.unsigned.map((u) => (
                  <li key={u.id}>
                    <button className="home-row" onClick={onAttest}>
                      <span className="home-kind">{kindLabel[u.kind] ?? u.kind}</span>
                      <span className="home-row-main">
                        <strong>{u.display_name}</strong>
                        <small>{u.title ?? "Utan titel"}</small>
                      </span>
                      <span className="home-row-meta">{day(u.created_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="home-sub" id="home-review">Nya resultat att granska <span>{toReview.length}</span></h3>
            {!data ? <Loading /> : !toReview.length ? (
              <p className="home-empty">Alla nya resultat är granskade.</p>
            ) : (
              <ul className="home-list">
                {toReview.slice(0, 8).map((d) => (
                  <li key={d.patient_id + d.key}>
                    <div className="home-row is-static">
                      <span className={"home-dot " + d.severity} aria-hidden="true" />
                      <button className="home-row-main" onClick={() => onOpenPatient({ id: d.patient_id, display_name: d.display_name }, d.category === "lab" ? "lab" : "vitals")}>
                        <strong>{d.display_name}</strong>
                        <small>{d.category === "lab" ? d.detail : d.title}</small>
                      </button>
                      {isDoctor && <button className="home-review" onClick={() => void review(d)}><Check size={13} /> Granska</button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card icon={<Megaphone size={18} />} title="Från administrationen" subtitle="Meddelanden till all personal">
            {!data ? <Loading /> : !data.announcements.length ? (
              <p className="home-empty">Inga meddelanden.</p>
            ) : (
              <ul className="home-notes">
                {data.announcements.map((a) => (
                  <li key={a.id}>
                    <strong>{a.title}</strong>
                    <p>{a.body}</p>
                    <small>{a.author} · {day(a.created_at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card icon={<Newspaper size={18} />} title="Nyheter från myndigheter" subtitle="Folkhälsomyndigheten, Läkemedelsverket och Socialstyrelsen">
            <div className="home-tabs" role="tablist" aria-label="Nyhetskälla">
              {[["all", "Alla"], ["fhm", "FHM"], ["lv", "Läkemedelsverket"], ["sos", "Socialstyrelsen"]].map(([id, label]) => (
                <button key={id} role="tab" aria-selected={newsTab === id} className={newsTab === id ? "active" : ""} onClick={() => setNewsTab(id)}>{label}</button>
              ))}
            </div>
            {!news ? <Loading /> : !items?.length ? (
              <p className="home-empty">Nyheterna kunde inte hämtas just nu.</p>
            ) : (
              <ul className="home-news">
                {items.map((n) => (
                  <li key={n.source + n.link + n.title}>
                    <a href={n.link} target="_blank" rel="noopener noreferrer">
                      <span className={"home-source " + n.source}>{n.name}</span>
                      <strong>{n.title}</strong>
                      <small>{day(n.date)} <ExternalLink size={12} /></small>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {news?.some((s) => !s.ok) && <p className="home-foot">Kunde inte nå {news.filter((s) => !s.ok).map((s) => s.name).join(", ")}.</p>}
          </Card>
        </div>
      </div>
    </section>
  );
}

/** Deviations in my pool, split into vital trends and lab values, each with its numbers and a review mark. */
function DeviationsCard({ data, isDoctor, onReview, onOpenPatient }: {
  data: HomeData | null;
  isDoctor: boolean;
  onReview: (d: HomeDeviation, undo?: boolean) => Promise<void>;
  onOpenPatient: (p: { id: string; display_name: string }, tab?: "overview" | "messages" | "lab" | "vitals") => void;
}) {
  const [tab, setTab] = useState<"vitals" | "lab" | "sync">("lab");
  const all = data?.deviations ?? [];
  const group = (c: string) => all.filter((d) => (d.category ?? (d.rule === "lab" ? "lab" : d.rule === "sync" ? "sync" : "vitals")) === c);
  const rows = group(tab).sort((a, b) => Number(!!a.reviewed_at) - Number(!!b.reviewed_at));
  const open = (c: string) => group(c).filter((d) => !d.reviewed_at).length;
  return (
    <Card id="home-deviations" icon={<Activity size={18} />} title="Avvikelser i din patientpool" subtitle="Dina patienter jämfört med sina egna värden och referensintervall">
      <div className="home-seg" role="tablist" aria-label="Typ av avvikelse">
        {([["lab", "Blodprover", <FlaskConical key="f" size={14} />], ["vitals", "Vitalparametrar", <Activity key="a" size={14} />],
          ["sync", "Datasynk", <WifiOff key="w" size={14} />]] as const).map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {icon} {label} {open(id) > 0 && <span>{open(id)}</span>}
          </button>
        ))}
      </div>
      {!data ? <Loading /> : !rows.length ? (
        <p className="home-empty">{tab === "lab" ? "Inga provsvar utanför referens senaste 90 dagarna." : tab === "sync" ? "Alla patienter har synkat de senaste 14 dagarna." : "Inga avvikande trender hos dina patienter."}</p>
      ) : (
        <ul className="dev-list">
          {rows.slice(0, 14).map((d) => (
            <li key={d.patient_id + (d.key ?? d.rule + d.detail)} className={d.reviewed_at ? "is-reviewed" : ""}>
              <span className={"home-dot " + d.severity} aria-label={d.severity === "high" ? "Hög" : d.severity === "warn" ? "Bevaka" : "Information"} />
              <button className="dev-main" onClick={() => onOpenPatient({ id: d.patient_id, display_name: d.display_name }, d.category === "lab" ? "lab" : d.category === "vitals" ? "vitals" : "overview")}>
                <strong>{d.display_name}</strong>
                <span>{d.category === "lab" ? d.data?.name ?? d.title : d.title}</span>
              </button>
              <div className="dev-viz">
                {d.category === "lab" && d.data?.value != null ? <LabRange d={d} /> : d.category === "vitals" ? <Trend d={d} /> : <small>{d.detail}</small>}
              </div>
              <div className="dev-review">
                {d.reviewed_at ? (
                  <span className="dev-done" title={`Granskad ${time(d.reviewed_at)}`}>
                    <Check size={13} /> {d.reviewed_by ?? "Granskad"}
                    {isDoctor && <button aria-label="Ångra granskning" onClick={() => void onReview(d, true)}><Undo2 size={12} /></button>}
                  </span>
                ) : isDoctor && d.category !== "sync" ? (
                  <button className="home-review" onClick={() => void onReview(d)}><Check size={13} /> Granska</button>
                ) : <span className="home-row-meta">{day(d.at)}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="home-foot">
        Blodprover: senaste publicerade värde per analys mot referensintervallet. Vitalparametrar: senaste 7 dagarna mot patientens 60 dagar före.
        En granskad trend kommer tillbaka nästa vecka om den består.
      </p>
    </Card>
  );
}

/** Where the value lies against the reference range. */
function LabRange({ d }: { d: HomeDeviation }) {
  const { value = 0, low, high, unit } = d.data ?? {};
  const lo = low ?? Math.min(value, high ?? value) * 0.5;
  const hi = high ?? Math.max(value, low ?? value) * 1.5;
  const min = Math.min(lo, value) - (hi - lo) * 0.35;
  const max = Math.max(hi, value) + (hi - lo) * 0.35;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / (max - min || 1)) * 100))}%`;
  return (
    <div className="lab-range" title={`Referens ${low != null ? num(low) : "–"}–${high != null ? num(high) : "–"} ${unit ?? ""}`}>
      <div className="lab-track">
        <i className="lab-band" style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }} />
        <i className={"lab-mark " + (d.data?.direction ?? "high")} style={{ left: pos(value) }} />
      </div>
      <div className="lab-label">
        <b className={d.data?.direction ?? "high"}>{num(value)} {unit}</b>
        <span>ref {low != null ? num(low) : "–"}–{high != null ? num(high) : "–"}</span>
      </div>
    </div>
  );
}

/** The trend: the patient's own baseline against the last week. */
function Trend({ d }: { d: HomeDeviation }) {
  const { recent, base, unit, direction, low } = d.data ?? {};
  if (recent == null) return <small>{d.detail}</small>;
  const change = base ? Math.round(((recent - base) / base) * 100) : null;
  return (
    <div className="trend">
      {base != null ? <span className="trend-base">{num(base)}</span> : low != null ? <span className="trend-base">gräns {num(low)}</span> : null}
      <ArrowRight size={13} />
      <b className={direction === "up" ? "up" : "down"}>{num(recent)} {unit}</b>
      {change != null && <span className={"trend-pct " + (direction === "up" ? "up" : "down")}>{change > 0 ? "+" : ""}{change} %</span>}
    </div>
  );
}

/** Monthly follow-up: a month calendar of my meetings, and the patients who need one booked. */
function FollowupCard({ data, now, onOpenPatient }: {
  data: HomeData | null; now: Date;
  onOpenPatient: (p: { id: string; display_name: string }, tab?: "overview" | "messages" | "lab" | "vitals") => void;
}) {
  const today = stockholmDate(now);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(null);
  const byDay = useMemo(() => {
    const map = new Map<string, HomeMeeting[]>();
    for (const m of data?.agenda ?? []) {
      const k = stockholmDate(new Date(m.starts_at));
      map.set(k, [...(map.get(k) ?? []), m]);
    }
    return map;
  }, [data]);
  const due = followupsDue(data?.followups, now);
  const dueDays = new Set(due.map((f) => f.due_on).filter(Boolean) as string[]);
  const first = month + "-01";
  const start = weekStart(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const visibleDays = days[35].slice(0, 7) === month ? days : days.slice(0, 35);
  const shift = (n: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
    setPicked(null);
  };
  const label = new Date(first + "T12:00:00Z").toLocaleDateString("sv-SE", { month: "long", year: "numeric", timeZone: "UTC" });
  const list = picked ? byDay.get(picked) ?? [] : [];
  const booked = (data?.followups ?? []).filter((f) => f.next_at);
  return (
    <Card id="home-followups" icon={<CalendarDays size={18} />} title="Uppföljning – månadsmöten" subtitle="Dina möten och patienter som behöver boka sin månatliga uppföljning">
      <div className="fu">
        <div className="fu-cal">
          <div className="fu-nav">
            <button aria-label="Föregående månad" onClick={() => shift(-1)}><ChevronLeft size={15} /></button>
            <strong>{label}</strong>
            <button aria-label="Nästa månad" onClick={() => shift(1)}><ChevronRight size={15} /></button>
          </div>
          <div className="fu-grid" role="grid">
            {["Må", "Ti", "On", "To", "Fr", "Lö", "Sö"].map((w) => <span key={w} className="fu-w">{w}</span>)}
            {visibleDays.map((d) => {
              const n = byDay.get(d)?.length ?? 0;
              return (
                <button key={d} role="gridcell"
                  className={"fu-d" + (d.slice(0, 7) !== month ? " is-out" : "") + (d === today ? " is-today" : "") + (d === picked ? " is-picked" : "")
                    + (n ? " has-meet" : "") + (dueDays.has(d) ? " is-due" : "")}
                  onClick={() => setPicked(d === picked ? null : d)}
                  aria-label={`${d}${n ? `, ${n} möten` : ""}${dueDays.has(d) ? ", uppföljning förfaller" : ""}`}>
                  {Number(d.slice(8))}
                  {n > 0 && <i>{n > 1 ? n : ""}</i>}
                </button>
              );
            })}
          </div>
          <div className="fu-legend"><span><i className="meet" /> Möte</span><span><i className="due" /> Uppföljning förfaller</span></div>
          {picked && (
            <ul className="fu-day">
              {!list.length ? <li className="home-empty">Inga möten {day(picked)}.</li> : list.map((m) => (
                <li key={m.id}>
                  <button onClick={() => onOpenPatient({ id: m.patient_id, display_name: m.display_name }, "messages")}>
                    <time>{clock(m.starts_at)}</time> {m.display_name} <small>{visitLabel[m.visit_type]}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="fu-side">
          <h3 className="home-sub">Behöver bokas <span>{due.length}</span></h3>
          {!data ? <Loading /> : !due.length ? <p className="home-empty">Alla har en uppföljning bokad eller inom en månad.</p> : (
            <ul className="fu-due">
              {due.slice(0, 8).map((f) => (
                <li key={f.patient_id}>
                  <span className="home-row-main">
                    <strong>{f.display_name}</strong>
                    <small className={f.overdue ? "late" : ""}>
                      {!f.last_at ? "Ingen uppföljning ännu" : f.overdue ? `Försenad sedan ${day(f.due_on)}` : `Förfaller ${day(f.due_on)}`}
                    </small>
                  </span>
                  <button className="home-review" onClick={() => onOpenPatient({ id: f.patient_id, display_name: f.display_name }, "messages")}>
                    Boka tid
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h3 className="home-sub">Bokade <span>{booked.length}</span></h3>
          {booked.length > 0 && (
            <ul className="fu-due">
              {booked.slice(0, 5).map((f) => (
                <li key={f.patient_id}>
                  <span className="home-row-main">
                    <strong>{f.display_name}</strong>
                    <small>{time(f.next_at!)} · {visitLabel[f.next_visit_type ?? ""] ?? ""}</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function ConsultItem({ c, onAct, onOpen }: { c: HomeConsultation; onAct: (c: HomeConsultation, op: "reply" | "close", reply?: string) => Promise<void>; onOpen: () => void }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(op: "reply" | "close") {
    setBusy(true);
    setError("");
    try {
      await onAct(c, op, op === "reply" ? reply.trim() : undefined);
      setReply("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const incoming = c.direction === "in";
  return (
    <li className={"home-consult " + (incoming && c.status === "open" ? "is-new" : "")}>
      <div className="home-consult-top">
        <span className="home-consult-who">{incoming ? `Från ${c.from_name ?? "kollega"}` : `Till ${c.to_name ?? "kollega"}`}</span>
        <span className={"home-status " + c.status}>{c.status === "open" ? (incoming ? "Väntar på ditt svar" : "Väntar på svar") : "Besvarad"}</span>
        <span className="home-row-meta">{day(c.created_at)}</span>
      </div>
      <button className="home-consult-patient" onClick={onOpen}>
        {c.display_name}{c.record ? ` · ${kindLabel[c.record.kind] ?? c.record.kind}${c.record.title ? `: ${c.record.title}` : ""}` : ""} <ArrowRight size={13} />
      </button>
      <p className="home-consult-msg">{c.message}</p>
      {c.reply && <p className="home-consult-reply"><strong>Svar:</strong> {c.reply}</p>}
      {incoming && c.status === "open" && (
        <textarea aria-label="Svar till kollegan" placeholder="Skriv ditt svar…" value={reply} maxLength={2000} onChange={(e) => setReply(e.target.value)} />
      )}
      {error && <p className="home-error">{error}</p>}
      <div className="home-consult-actions">
        {incoming && c.status === "open" && (
          <button className="button" disabled={busy || !reply.trim()} onClick={() => void run("reply")}><Send size={14} /> Svara</button>
        )}
        <button className="button secondary" disabled={busy} onClick={() => void run("close")}><X size={14} /> Avsluta</button>
      </div>
    </li>
  );
}

function Card({ id, icon, title, subtitle, action, children }: { id?: string; icon: ReactNode; title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  return (
    <section className="home-card" id={id} ref={ref} onAnimationEnd={() => ref.current?.classList.remove("is-flash")}>
      <header>
        <span className="home-card-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
function Loading() {
  return <p className="home-empty">Hämtar…</p>;
}

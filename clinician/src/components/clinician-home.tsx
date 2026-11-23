"use client";
import {
  Activity, ArrowRight, ClipboardCheck, ExternalLink, Megaphone, MessageSquareText, MessagesSquare, Newspaper, RefreshCw, Send, TriangleAlert, Users, X,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { HomeConsultation, HomeData } from "@/lib/clinician-home";
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
const time = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
const day = (iso: string | null) =>
  iso ? new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short", timeZone: "Europe/Stockholm" }) : "";
const kindLabel: Record<string, string> = { lab: "Provsvar", vaccination: "Vaccination", imaging: "Bilddiagnostik" };
function greeting() {
  const hour = Number(new Date().toLocaleString("sv-SE", { hour: "2-digit", hour12: false, timeZone: "Europe/Stockholm" }));
  return hour < 10 ? "God morgon" : hour < 18 ? "God eftermiddag" : "God kväll";
}

export function ClinicianHome({ demo, name, demoData, onOpenPatient, onAttest, onMyPatients }: {
  demo: boolean;
  name: string;
  demoData: HomeData;
  onOpenPatient: (patient: { id: string; display_name: string }, tab?: "overview" | "messages") => void;
  onAttest: () => void;
  onMyPatients: () => void;
}) {
  const [data, setData] = useState<HomeData | null>(demo ? demoData : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [news, setNews] = useState<NewsSource[] | null>(null);
  const [newsTab, setNewsTab] = useState("all");

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
    // New patient messages and consultations show up within 30 s while the page is visible.
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
    await load();
  }

  const counts = data?.counts;
  const items = news?.flatMap((s) => s.items.map((i) => ({ ...i, source: s.source, name: s.name })))
    .filter((i) => newsTab === "all" || i.source === newsTab)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, newsTab === "all" ? 8 : 6);
  const displayName = name.replace(/\s*\(.*\)\s*$/, "");

  return (
    <section className="home" aria-label="Översikt">
      <header className="home-head">
        <div>
          <h1>{greeting()}, {displayName}</h1>
          <p>{new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Stockholm" })}</p>
        </div>
        {!demo && (
          <button className="button secondary" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={15} className={busy ? "home-spin" : ""} /> Uppdatera
          </button>
        )}
      </header>
      {error && <div className="alert error" role="alert">{error}</div>}

      <div className="home-kpis">
        <Kpi icon={<Users size={18} />} label="Mina patienter" value={counts?.assigned} sub={counts ? `${counts.clinic} i kliniken` : ""} onClick={onMyPatients} />
        <Kpi icon={<ClipboardCheck size={18} />} label="Osignerade ärenden" value={counts?.unsigned} tone={counts?.unsigned ? "alert" : ""} sub="väntar på granskning" onClick={onAttest} />
        <Kpi icon={<MessageSquareText size={18} />} label="Patientmeddelanden" value={counts?.messages} tone={counts?.messages ? "alert" : ""} sub="väntar på svar" />
        <Kpi icon={<MessagesSquare size={18} />} label="Konsultationer" value={counts?.consultations} tone={counts?.consultations ? "alert" : ""} sub="väntar på ditt svar" />
        <Kpi icon={<TriangleAlert size={18} />} label="Avvikelser" value={data?.deviations.length} tone={data?.deviations.some((d) => d.severity === "high") ? "alert" : ""} sub="i din patientpool" />
      </div>

      <div className="home-grid">
        <div className="home-col">
          <Card icon={<Activity size={18} />} title="Avvikelser i din patientpool" subtitle="Senaste 7 dagarna jämfört med patientens egna 60 dagar före">
            {!data ? <Loading /> : !data.deviations.length ? (
              <p className="home-empty">Inga avvikelser hos dina patienter just nu.</p>
            ) : (
              <ul className="home-list">
                {data.deviations.slice(0, 12).map((d, i) => (
                  <li key={d.patient_id + d.rule + i}>
                    <button className="home-row" onClick={() => onOpenPatient({ id: d.patient_id, display_name: d.display_name })}>
                      <span className={"home-dot " + d.severity} aria-label={d.severity === "high" ? "Hög" : d.severity === "warn" ? "Bevaka" : "Information"} />
                      <span className="home-row-main">
                        <strong>{d.display_name} · {d.title}</strong>
                        <small>{d.detail}</small>
                      </span>
                      <span className="home-row-meta">{day(d.at)}</span>
                      <ArrowRight size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="home-foot">
              Regler: vilopuls minst +5 slag/min och +10 %, HRV −20 %, sömn −1 tim och under 6,5 tim, syremättnad under 92 %,
              steg −40 %, ingen synk på 14 dagar, senaste provsvar utanför referens. Ingen AI, inga data lämnar systemet.
            </p>
          </Card>

          <Card icon={<MessageSquareText size={18} />} title="Meddelanden från patienter" subtitle="Väntar på svar från vårdteamet">
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

          <Card icon={<MessagesSquare size={18} />} title="Konsultationer" subtitle="Skickas från patientens översikt">
            {!data ? <Loading /> : !data.consultations.length ? (
              <p className="home-empty">Inga öppna konsultationer.</p>
            ) : (
              <ul className="home-consults">
                {data.consultations.map((c) => <ConsultItem key={c.id} c={c} onAct={act} onOpen={() => onOpenPatient({ id: c.patient_id, display_name: c.display_name })} />)}
              </ul>
            )}
          </Card>
        </div>

        <div className="home-col">
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

          <Card icon={<ClipboardCheck size={18} />} title="Osignerade ärenden" subtitle="Dina patienter och dina egna utkast"
            action={<button className="home-link" onClick={onAttest}>Visa alla <ArrowRight size={14} /></button>}>
            {!data ? <Loading /> : !data.unsigned.length ? (
              <p className="home-empty">Inget väntar på granskning.</p>
            ) : (
              <ul className="home-list">
                {data.unsigned.map((u) => (
                  <li key={u.id}>
                    <button className="home-row" onClick={onAttest}>
                      <span className="home-row-main">
                        <strong>{u.display_name}</strong>
                        <small>{kindLabel[u.kind] ?? u.kind}{u.title ? ` · ${u.title}` : ""}</small>
                      </span>
                      <span className="home-row-meta">{day(u.created_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card icon={<Newspaper size={18} />} title="Nyheter" subtitle="Folkhälsomyndigheten, Läkemedelsverket och Socialstyrelsen">
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

function Kpi({ icon, label, value, sub, tone = "", onClick }: { icon: ReactNode; label: string; value: number | undefined; sub: string; tone?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="home-kpi-icon">{icon}</span>
      <span className="home-kpi-text">
        <span>{label}</span>
        <strong>{value ?? "—"}</strong>
        <small>{sub}</small>
      </span>
    </>
  );
  return onClick
    ? <button className={"home-kpi " + tone} onClick={onClick}>{body}</button>
    : <div className={"home-kpi " + tone}>{body}</div>;
}
function Card({ icon, title, subtitle, action, children }: { icon: ReactNode; title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="home-card">
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

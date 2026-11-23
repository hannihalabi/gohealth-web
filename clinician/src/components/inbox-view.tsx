"use client";
import { ArrowRight, Inbox, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PatientMessages } from "@/components/patient-messages";
import "./inbox-view.css";

export type InboxConversation = {
  patient_id: string;
  display_name: string;
  identity_label: string;
  mine: boolean;
  waiting: number;
  last_at: string;
  last_sender: "clinician" | "patient";
  last_body: string;
};
type InboxData = { waiting: number; conversations: InboxConversation[] };
type Filter = "waiting" | "mine" | "all";

async function post(body: unknown) {
  const r = await fetch("/api/clinical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Inkorgen kunde inte hämtas.");
  return data;
}
function when(iso: string) {
  const d = new Date(iso);
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  const same = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" }) === today;
  return same
    ? d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" })
    : d.toLocaleDateString("sv-SE", { day: "numeric", month: "short", timeZone: "Europe/Stockholm" });
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");

const demoInbox: InboxData = {
  waiting: 1,
  conversations: [
    { patient_id: "00000000-0000-4000-8000-000000000001", display_name: "Alex Lind", identity_label: "TEST-0001", mine: true, waiting: 1,
      last_at: "2026-11-16T10:05:00Z", last_sender: "patient", last_body: "Tack! Behöver jag ta om sköldkörtelprovet?" },
    { patient_id: "00000000-0000-4000-8000-000000000002", display_name: "Kim Berg", identity_label: "TEST-0002", mine: true, waiting: 0,
      last_at: "2026-11-12T08:30:00Z", last_sender: "clinician", last_body: "Välkommen! Hör av dig om du har frågor." },
  ],
};

/** All patient conversations: the list on the left, the selected chat on the right. */
export function InboxView({ demo, authorName, onOpenPatient, onWaiting }: {
  demo: boolean;
  authorName: string;
  onOpenPatient: (patient: { id: string; display_name: string }) => void;
  onWaiting?: (count: number) => void;
}) {
  const [data, setData] = useState<InboxData | null>(demo ? demoInbox : null);
  const [filter, setFilter] = useState<Filter>("waiting");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const marker = useRef<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (demo) return;
    if (!silent) setBusy(true);
    try {
      const next: InboxData = await post({ action: "inbox", op: "list" });
      setData(next);
      onWaiting?.(next.waiting);
      setError("");
    } catch (e) {
      if (!silent) setError((e as Error).message);
    } finally {
      if (!silent) setBusy(false);
    }
  }, [demo, onWaiting]);

  // The list is fetched (and audited) once, then refetched only when the cheap check sees a change.
  useEffect(() => {
    if (demo) return;
    let active = true;
    let checking = false;
    void load();
    const check = async () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const next = await post({ action: "inbox", op: "poll" });
        if (!active) return;
        if (marker.current !== null && next.marker !== marker.current) await load(true);
        marker.current = next.marker;
      } catch {
        // Retried on the next tick.
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [demo, load]);

  const all = data?.conversations ?? [];
  const counts = { waiting: all.filter((c) => c.mine && c.waiting > 0).length, mine: all.filter((c) => c.mine).length, all: all.length };
  const rows = all.filter((c) => (filter === "waiting" ? c.mine && c.waiting > 0 : filter === "mine" ? c.mine : true));
  const current = all.find((c) => c.patient_id === selected) ?? null;

  useEffect(() => {
    // Keep a chat selected on wide screens: the first row when nothing is chosen yet.
    if (!selected && rows.length && window.matchMedia("(min-width: 980px)").matches) setSelected(rows[0].patient_id);
  }, [rows, selected]);

  return (
    <section className="inbox" aria-label="Inkorg">
      <div className={"inbox-list" + (current ? " has-selection" : "")}>
        <header>
          <div>
            <h1>Inkorg</h1>
            <p>Meddelanden från patienter</p>
          </div>
          {!demo && (
            <button className="grid-btn" aria-label="Uppdatera" disabled={busy} onClick={() => void load()}>
              <RefreshCw size={15} />
            </button>
          )}
        </header>
        <div className="inbox-filters" role="tablist" aria-label="Filter">
          {([["waiting", "Väntar på svar"], ["mine", "Mina"], ["all", "Hela kliniken"]] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
              {label} <span>{counts[id]}</span>
            </button>
          ))}
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}
        {!data ? (
          <p className="inbox-empty">Hämtar…</p>
        ) : !rows.length ? (
          <div className="inbox-empty">
            <Inbox size={22} />
            <p>{filter === "waiting" ? "Inget väntar på svar." : "Inga konversationer ännu. Skriv till en patient från patientens flik Meddelanden."}</p>
          </div>
        ) : (
          <ul>
            {rows.map((c) => (
              <li key={c.patient_id}>
                <button className={"inbox-row" + (c.patient_id === selected ? " selected" : "") + (c.waiting > 0 ? " is-waiting" : "")}
                  onClick={() => setSelected(c.patient_id)}>
                  <span className="inbox-avatar">{initials(c.display_name)}</span>
                  <span className="inbox-main">
                    <span className="inbox-top">
                      <strong>{c.display_name}</strong>
                      <small>{when(c.last_at)}</small>
                    </span>
                    <span className="inbox-preview">{c.last_sender === "clinician" ? "Vårdteamet: " : ""}{c.last_body}</span>
                  </span>
                  {c.waiting > 0 && <span className="inbox-badge" aria-label={`${c.waiting} väntar på svar`}>{c.waiting}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="inbox-chat">
        {current ? (
          <>
            <div className="inbox-chat-head">
              <button className="inbox-back" onClick={() => setSelected(null)}>← Inkorg</button>
              <div>
                <strong>{current.display_name}</strong>
                <small>{current.identity_label}</small>
              </div>
              <button className="button secondary" onClick={() => onOpenPatient({ id: current.patient_id, display_name: current.display_name })}>
                Öppna journal <ArrowRight size={15} />
              </button>
            </div>
            <PatientMessages key={current.patient_id} patientId={current.patient_id} patientName={current.display_name}
              demo={demo} authorName={authorName} onChanged={() => void load(true)} />
          </>
        ) : (
          <div className="inbox-placeholder">
            <Inbox size={28} />
            <p>Välj en konversation</p>
          </div>
        )}
      </div>
    </section>
  );
}

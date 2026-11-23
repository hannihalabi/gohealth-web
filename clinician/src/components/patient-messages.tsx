"use client";
import { Archive, CalendarCheck, CalendarClock, CalendarPlus, CalendarX, CheckCheck, Plus, RefreshCw, Send, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { builtInQuickReplies, timeRange, visitTypes, type VisitType } from "@/lib/booking";
import "./patient-messages.css";

export type Booking = {
  id: string;
  status: "open" | "booked" | "withdrawn";
  visit_type: VisitType;
  starts_at: string | null;
  ends_at: string | null;
  clinician_name?: string | null;
  can_unbook?: boolean;
};
export type PatientMessage = {
  id: string;
  sender: "clinician" | "patient";
  kind?: "text" | "booking" | "booked" | "unbooked";
  author_name: string;
  body: string;
  created_at: string;
  read_at: string | null;
  handled_at?: string | null;
  archived_at?: string | null;
  booking?: Booking | null;
};
type Thread = { can_message: boolean; free_times?: number; messages: PatientMessage[] };
type QuickReply = { id: string; body: string };
type Op = "thread" | "send" | "resolve" | "archive" | "book" | "unbook";

async function post(body: unknown) {
  const r = await fetch("/api/clinical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Meddelandet kunde inte skickas.");
  return data;
}
const when = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });

function demoThread(patientName: string): Thread {
  return {
    can_message: true,
    free_times: 6,
    messages: [
      { id: "demo-m1", sender: "clinician", author_name: "Dr. Berg", body: "Hej! Dina provsvar är klara. Hör av dig om du har frågor.", created_at: "2026-11-16T09:12:00Z", read_at: "2026-11-16T10:02:00Z" },
      { id: "demo-m2", sender: "patient", author_name: patientName, body: "Tack! Behöver jag ta om sköldkörtelprovet?", created_at: "2026-11-16T10:05:00Z", read_at: null, handled_at: null },
    ],
  };
}

/** Conversation between the care team and the patient. The patient reads, replies and books in the app. */
export function PatientMessages({ patientId, patientName, demo, authorName, onChanged, onCalendar }: {
  patientId: string;
  patientName: string;
  demo: boolean;
  authorName: string;
  onChanged?: () => void;
  onCalendar?: () => void;
}) {
  const [thread, setThread] = useState<Thread | null>(demo ? demoThread(patientName) : null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"book" | "close" | null>(null);
  const [visit, setVisit] = useState<VisitType>("video");
  const [note, setNote] = useState("");
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const run = useCallback(async (op: Op, extra: Record<string, unknown> = {}) => {
    if (demo) {
      const now = new Date().toISOString();
      setThread((t) => {
        if (!t) return t;
        const handled = t.messages.map((m) => (m.sender === "patient" && !m.handled_at ? { ...m, handled_at: now } : m));
        const own = { id: crypto.randomUUID(), sender: "clinician" as const, author_name: authorName, created_at: now, read_at: null };
        if (op === "send") return { ...t, messages: [...handled, { ...own, body: String(extra.body ?? "") }] };
        if (op === "resolve") return { ...t, messages: handled };
        if (op === "archive") return { ...t, messages: handled.map((m) => (m.archived_at ? m : { ...m, archived_at: now,
          booking: m.booking?.status === "open" ? { ...m.booking, status: "withdrawn" as const } : m.booking })) };
        if (op === "book") {
          const vt = extra.visitType as VisitType;
          return { ...t, messages: [...handled.map((m) => (m.booking?.status === "open" ? { ...m, booking: { ...m.booking, status: "withdrawn" as const } } : m)),
            { ...own, kind: "booking", body: String(extra.body ?? `Välj en tid för ${visitTypes[vt].toLowerCase()} nedan.`),
              booking: { id: crypto.randomUUID(), status: "open", visit_type: vt, starts_at: null, ends_at: null } }] };
        }
        if (op === "unbook") {
          const target = t.messages.find((m) => m.booking?.id === extra.bookingId)?.booking;
          return { ...t, messages: [...t.messages.map((m) => (m.booking?.id === extra.bookingId ? { ...m, booking: { ...m.booking!, status: "withdrawn" as const } } : m)),
            { ...own, kind: "unbooked", body: target?.status === "booked" && target.starts_at ? `Din tid ${timeRange(target.starts_at, null)} är avbokad.` : "Bokningsförfrågan är återkallad." }] };
        }
        return t;
      });
      return;
    }
    setThread(await post({ action: "messages", op, patientId, ...extra }));
  }, [demo, patientId, authorName]);

  useEffect(() => {
    run("thread").catch((e: Error) => setError(e.message));
  }, [run]);
  useEffect(() => {
    if (demo) return;
    post({ action: "quick_replies", op: "list" }).then((r) => setReplies(r.replies ?? [])).catch(() => setReplies([]));
  }, [demo]);
  // While the chat is open and visible, a cheap check every 4 s; the conversation is fetched only when it changed.
  const marker = useRef<string | null>(null);
  useEffect(() => {
    if (demo) return;
    let active = true;
    let busyCheck = false;
    const check = async () => {
      if (busyCheck || document.visibilityState !== "visible") return;
      busyCheck = true;
      try {
        const next = (await post({ action: "messages", op: "poll", patientId }))?.marker as string | undefined;
        if (!active || next === undefined) return;
        if (marker.current !== null && next !== marker.current) setThread(await post({ action: "messages", op: "thread", patientId }));
        marker.current = next;
      } catch {
        // A missed check is retried on the next tick.
      } finally {
        busyCheck = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 4000);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [demo, patientId]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [thread?.messages.length]);

  async function act(op: Op, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      await run(op, extra);
      if (op === "send") setBody("");
      if (op === "book") { setNote(""); setPanel(null); }
      if (op === "archive") setPanel(null);
      if (!demo) marker.current = (await post({ action: "messages", op: "poll", patientId }).catch(() => null))?.marker ?? marker.current;
      if (op !== "thread") onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (body.trim()) void act("send", { body: body.trim() });
  }
  function insertReply(text: string) {
    setBody((b) => (b.trim() ? b.replace(/\s*$/, "\n") + text : text));
    input.current?.focus();
  }
  async function saveReply() {
    const text = body.trim();
    if (!text) return;
    try {
      if (demo) setReplies((r) => [...r, { id: crypto.randomUUID(), body: text }]);
      else setReplies((await post({ action: "quick_replies", op: "add", body: text })).replies);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function removeReply(id: string) {
    try {
      if (demo) setReplies((r) => r.filter((x) => x.id !== id));
      else setReplies((await post({ action: "quick_replies", op: "remove", id })).replies);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const messages = thread?.messages ?? [];
  const waiting = messages.filter((m) => m.sender === "patient" && !m.handled_at && !m.archived_at).length;
  const open = messages.some((m) => !m.archived_at);
  const closed = messages.length > 0 && !open;
  const freeTimes = thread?.free_times ?? 0;
  const knownReply = [...builtInQuickReplies, ...replies.map((r) => r.body)].includes(body.trim());

  return (
    <section className="panel pm">
      <div className="panel-heading">
        <div>
          <h2>Meddelanden</h2>
          <p>Patienten får en notis i appen och kan svara och boka tid där.</p>
        </div>
        <div className="pm-tools">
          {waiting > 0 && (
            <button className="button secondary" disabled={busy} onClick={() => void act("resolve")} title="Markera patientens meddelanden som hanterade utan att svara">
              <CheckCheck size={15} /> Markera hanterat
            </button>
          )}
          {thread?.can_message && (
            <button className={"button secondary" + (panel === "book" ? " is-on" : "")} disabled={busy} onClick={() => setPanel(panel === "book" ? null : "book")}>
              <CalendarPlus size={15} /> Boka tid
            </button>
          )}
          <button className={"button secondary" + (panel === "close" ? " is-on" : "")} disabled={busy || !open} onClick={() => setPanel(panel === "close" ? null : "close")}
            title={open ? "Stäng och arkivera chatten" : "Chatten är stängd"}>
            <Archive size={15} /> Stäng chatt
          </button>
          <button className="button secondary" aria-label="Uppdatera" disabled={busy} onClick={() => void act("thread")}>
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {panel === "close" && (
        <div className="pm-panel pm-confirm" role="alertdialog" aria-label="Stäng chatten">
          <p><strong>Stäng chatten?</strong> Den försvinner ur patientens app men finns kvar här som arkiverad. Bokade tider ligger kvar, öppna bokningsförfrågningar återkallas.</p>
          <div>
            <button className="button secondary" onClick={() => setPanel(null)}>Avbryt</button>
            <button className="button primary" disabled={busy} onClick={() => void act("archive")}><Archive size={15} /> Stäng chatt</button>
          </div>
        </div>
      )}
      {panel === "book" && (
        <form className="pm-panel pm-book" onSubmit={(e) => { e.preventDefault(); void act("book", { visitType: visit, ...(note.trim() ? { body: note.trim() } : {}) }); }}>
          <div className="pm-book-head">
            <strong>Be {patientName} boka en tid</strong>
            <button type="button" className="icon-button" aria-label="Stäng" onClick={() => setPanel(null)}><X size={16} /></button>
          </div>
          <div className="pm-visit" role="radiogroup" aria-label="Typ av tid">
            {(Object.keys(visitTypes) as VisitType[]).map((v) => (
              <button type="button" key={v} role="radio" aria-checked={visit === v} className={visit === v ? "active" : ""} onClick={() => setVisit(v)}>{visitTypes[v]}</button>
            ))}
          </div>
          <textarea rows={2} maxLength={4000} placeholder={`Valfritt meddelande, t.ex. "Vi går igenom dina provsvar."`} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="pm-book-foot">
            {freeTimes > 0 ? (
              <span>Patienten väljer bland dina {freeTimes} lediga tider.</span>
            ) : (
              <span className="pm-warn">Du har inga lediga tider.{onCalendar && <> <button type="button" className="link-button" onClick={onCalendar}>Lägg in tider i Kalender</button></>}</span>
            )}
            <button className="button primary" disabled={busy || freeTimes === 0}><Send size={15} /> Skicka bokningslänk</button>
          </div>
        </form>
      )}

      <div className="pm-thread" aria-live="polite">
        {!thread ? <p className="pm-empty">Hämtar…</p> : !messages.length ? (
          <p className="pm-empty">Inga meddelanden ännu. Skriv det första nedan, så får {patientName} en notis i appen.</p>
        ) : (
          messages.map((m, i) => {
            const closes = m.archived_at && messages[i + 1]?.archived_at !== m.archived_at;
            return (
              <Fragment key={m.id}>
                <MessageRow m={m} busy={busy} onUnbook={(id) => void act("unbook", { bookingId: id })} />
                {closes && (
                  <div className="pm-closed" role="separator"><Archive size={13} /> Chatten stängdes {when(m.archived_at!)}</div>
                )}
              </Fragment>
            );
          })
        )}
        <div ref={end} />
      </div>

      {thread && !thread.can_message ? (
        <p className="pm-note">Patienten har inget verifierat appkonto, så meddelanden kan inte skickas.</p>
      ) : (
        <>
          {closed && <p className="pm-note">Chatten är stängd. Ett nytt meddelande startar en ny chatt i patientens app.</p>}
          <div className="pm-replies" aria-label="Snabbsvar">
            {builtInQuickReplies.map((r) => (
              <button type="button" key={r} className="pm-chip" title={r} onClick={() => insertReply(r)}>{r}</button>
            ))}
            {replies.map((r) => (
              <span key={r.id} className="pm-chip own">
                <button type="button" title={r.body} onClick={() => insertReply(r.body)}>{r.body}</button>
                <button type="button" aria-label="Ta bort snabbsvar" onClick={() => void removeReply(r.id)}><X size={12} /></button>
              </span>
            ))}
          </div>
          <form className="pm-compose" onSubmit={submit}>
            <textarea ref={input} aria-label={`Meddelande till ${patientName}`} placeholder={`Skriv till ${patientName}…`} rows={3} maxLength={4000}
              value={body} onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); }} />
            <div className="pm-compose-actions">
              {body.trim() && !knownReply && body.trim().length <= 1000 && (
                <button type="button" className="link-button" onClick={() => void saveReply()}><Plus size={13} /> Spara som snabbsvar</button>
              )}
              <button className="button" disabled={busy || !body.trim()}><Send size={15} /> Skicka</button>
            </div>
          </form>
        </>
      )}
      {error && <div className="alert error" role="alert">{error}</div>}
    </section>
  );
}

function MessageRow({ m, busy, onUnbook }: { m: PatientMessage; busy: boolean; onUnbook: (bookingId: string) => void }) {
  const team = m.sender === "clinician";
  if (m.kind === "booked" || m.kind === "unbooked") {
    return (
      <div className={"pm-event" + (m.archived_at ? " is-archived" : "") + (m.kind === "unbooked" ? " is-cancel" : "")}>
        {m.kind === "booked" ? <CalendarCheck size={14} /> : <CalendarX size={14} />}
        <span><strong>{m.author_name}:</strong> {m.body}</span>
        <small>{when(m.created_at)}{m.sender === "patient" && m.kind === "unbooked" && !m.handled_at && !m.archived_at && <span className="pm-wait"> · Väntar på svar</span>}</small>
      </div>
    );
  }
  const b = m.kind === "booking" ? m.booking : null;
  return (
    <div className={"pm-msg " + (team ? "is-team" : "is-patient") + (m.archived_at ? " is-archived" : "")}>
      <div className="pm-bubble">
        {m.body}
        {b && (
          <div className={"pm-booking is-" + b.status}>
            <CalendarClock size={16} />
            <div>
              <strong>{visitTypes[b.visit_type]}</strong>
              <span>
                {b.status === "booked" && b.starts_at ? `Bokad ${timeRange(b.starts_at, b.ends_at)}`
                  : b.status === "open" ? "Väntar på att patienten bokar" : "Återkallad"}
              </span>
            </div>
            {!m.archived_at && b.status === "open" && (
              <button type="button" disabled={busy} onClick={() => onUnbook(b.id)}>Återkalla</button>
            )}
            {b.status === "booked" && b.can_unbook !== false && (
              <button type="button" disabled={busy} onClick={() => onUnbook(b.id)}>Avboka</button>
            )}
          </div>
        )}
      </div>
      <small>
        {m.author_name} · {when(m.created_at)}
        {team && (m.read_at ? " · Läst" : " · Ej läst")}
        {!team && !m.handled_at && !m.archived_at && <span className="pm-wait"> · Väntar på svar</span>}
      </small>
    </div>
  );
}

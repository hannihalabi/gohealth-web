"use client";
import { CheckCheck, RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import "./patient-messages.css";

export type PatientMessage = {
  id: string;
  sender: "clinician" | "patient";
  author_name: string;
  body: string;
  created_at: string;
  read_at: string | null;
  handled_at?: string | null;
};
type Thread = { can_message: boolean; messages: PatientMessage[] };

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

/** Conversation between the care team and the patient. The patient reads and replies in the app. */
export function PatientMessages({ patientId, patientName, demo, authorName, onChanged }: {
  patientId: string;
  patientName: string;
  demo: boolean;
  authorName: string;
  onChanged?: () => void;
}) {
  const [thread, setThread] = useState<Thread | null>(demo ? {
    can_message: true,
    messages: [
      { id: "demo-m1", sender: "clinician", author_name: "Dr. Berg", body: "Hej! Dina provsvar är klara. Hör av dig om du har frågor.", created_at: "2026-11-16T09:12:00Z", read_at: "2026-11-16T10:02:00Z" },
      { id: "demo-m2", sender: "patient", author_name: patientName, body: "Tack! Behöver jag ta om sköldkörtelprovet?", created_at: "2026-11-16T10:05:00Z", read_at: null, handled_at: null },
    ],
  } : null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);

  const run = useCallback(async (op: "thread" | "send" | "resolve", text?: string) => {
    if (demo) {
      setThread((t) => t && {
        ...t,
        messages: op === "send"
          ? [...t.messages.map((m) => (m.sender === "patient" ? { ...m, handled_at: new Date().toISOString() } : m)),
             { id: crypto.randomUUID(), sender: "clinician", author_name: authorName, body: text ?? "", created_at: new Date().toISOString(), read_at: null }]
          : op === "resolve" ? t.messages.map((m) => (m.sender === "patient" ? { ...m, handled_at: new Date().toISOString() } : m)) : t.messages,
      });
      return;
    }
    setThread(await post({ action: "messages", op, patientId, ...(text ? { body: text } : {}) }));
  }, [demo, patientId, authorName]);

  useEffect(() => {
    run("thread").catch((e: Error) => setError(e.message));
  }, [run]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [thread?.messages.length]);

  async function act(op: "send" | "resolve" | "thread") {
    setBusy(true);
    setError("");
    try {
      await run(op, op === "send" ? body.trim() : undefined);
      if (op === "send") setBody("");
      if (op !== "thread") onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (body.trim()) void act("send");
  }

  const waiting = thread?.messages.filter((m) => m.sender === "patient" && !m.handled_at).length ?? 0;
  return (
    <section className="panel pm">
      <div className="panel-heading">
        <div>
          <h2>Meddelanden</h2>
          <p>Patienten får en notis i appen och kan svara här.</p>
        </div>
        <div className="pm-tools">
          {waiting > 0 && (
            <button className="button secondary" disabled={busy} onClick={() => void act("resolve")} title="Markera patientens meddelanden som hanterade utan att svara">
              <CheckCheck size={15} /> Markera hanterat
            </button>
          )}
          <button className="button secondary" aria-label="Uppdatera" disabled={busy} onClick={() => void act("thread")}>
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      <div className="pm-thread" aria-live="polite">
        {!thread ? <p className="pm-empty">Hämtar…</p> : !thread.messages.length ? (
          <p className="pm-empty">Inga meddelanden ännu. Skriv det första nedan, så får {patientName} en notis i appen.</p>
        ) : (
          thread.messages.map((m) => (
            <div key={m.id} className={"pm-msg " + (m.sender === "clinician" ? "is-team" : "is-patient")}>
              <div className="pm-bubble">{m.body}</div>
              <small>
                {m.author_name} · {when(m.created_at)}
                {m.sender === "clinician" && (m.read_at ? " · Läst" : " · Ej läst")}
                {m.sender === "patient" && !m.handled_at && <span className="pm-wait"> · Väntar på svar</span>}
              </small>
            </div>
          ))
        )}
        <div ref={end} />
      </div>
      {thread && !thread.can_message ? (
        <p className="pm-note">Patienten har inget verifierat appkonto, så meddelanden kan inte skickas.</p>
      ) : (
        <form className="pm-compose" onSubmit={submit}>
          <textarea aria-label={`Meddelande till ${patientName}`} placeholder={`Skriv till ${patientName}…`} rows={3} maxLength={4000}
            value={body} onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); }} />
          <button className="button" disabled={busy || !body.trim()}><Send size={15} /> Skicka</button>
        </form>
      )}
      {error && <div className="alert error" role="alert">{error}</div>}
    </section>
  );
}

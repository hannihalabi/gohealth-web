"use client";
import { CheckCircle2, Eye, MessageSquareText, Pencil, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isChange, roleName, verbText, whenText, type HistoryEvent } from "@/lib/history";
import { RoleBadge } from "@/components/role-badge";
import "./patient-history.css";

async function load(patientId: string): Promise<HistoryEvent[]> {
  const r = await fetch("/api/clinical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "history", patientId }),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Historiken kunde inte hämtas.");
  return data.events;
}

function Row({ e }: { e: HistoryEvent }) {
  const icon = e.action.startsWith("messages") || e.action.startsWith("booking") || e.action.startsWith("consultation")
    ? <MessageSquareText size={16} /> : isChange(e.action) ? <Pencil size={16} /> : <Eye size={16} />;
  return (
    <li className="ph-row">
      <span className="ph-icon">{icon}</span>
      <span className="ph-text">
        <strong>{e.actor ?? "Okänd användare"}</strong>
        {e.role && <RoleBadge role={e.role} small />}
        {" "}{verbText(e)}
        {e.record && e.record.revision > 1 && <small> (version {e.record.revision})</small>}
      </span>
      <time dateTime={e.at}>{whenText(e.at)}</time>
    </li>
  );
}

/** Who did what to this patient: changes first, as sentences; the access log (who opened what) in a drop-down. */
export function PatientHistory({ patientId, demo, demoEvents }: { patientId: string; demo: boolean; demoEvents: HistoryEvent[] }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(demo ? demoEvents : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    if (demo) return;
    setBusy(true);
    try {
      setEvents(await load(patientId));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [demo, patientId]);
  useEffect(() => { void run(); }, [run]);

  const changes = (events ?? []).filter((e) => isChange(e.action));
  const reads = (events ?? []).filter((e) => !isChange(e.action));
  const people = Array.from(new Map((events ?? []).filter((e) => e.actor && e.role !== "patient").map((e) => [e.actor, e.role])).entries());
  return (
    <section className="panel ph">
      <div className="panel-heading">
        <div>
          <h2>Historik</h2>
          <p>Vem som gjort vad för patienten, så att fel kan spåras och rättas. Ingen text eller inga provvärden visas.</p>
        </div>
        <button className="button secondary" aria-label="Uppdatera" disabled={busy || demo} onClick={() => void run()}><RefreshCw size={15} /></button>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {!events ? <p className="ph-empty">Hämtar…</p> : (
        <>
          {people.length > 0 && (
            <p className="ph-people">Inblandad personal: {people.map(([n, r]) => `${n} (${roleName(r)})`).join(", ")}</p>
          )}
          <h3 className="ph-h"><CheckCircle2 size={15} /> Ändringar <span>({changes.length})</span></h3>
          {changes.length ? <ul className="ph-list">{changes.map((e) => <Row key={e.id} e={e} />)}</ul>
            : <p className="ph-empty">Inga ändringar ännu.</p>}
          <details className="ph-access">
            <summary><Eye size={15} /> Åtkomstlogg: vem som öppnat och läst <span>({reads.length})</span></summary>
            {reads.length ? <ul className="ph-list">{reads.map((e) => <Row key={e.id} e={e} />)}</ul> : <p className="ph-empty">Ingen åtkomst loggad.</p>}
          </details>
        </>
      )}
    </section>
  );
}

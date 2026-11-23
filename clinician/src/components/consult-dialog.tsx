"use client";
import { Send, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Colleague } from "@/lib/clinician-home";
import type { ClinicalRecord } from "@/lib/model";

async function post(body: unknown) {
  const r = await fetch("/api/clinical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Konsultationen kunde inte skickas.");
  return data;
}
const kindLabel: Record<string, string> = { lab: "Provsvar", vaccination: "Vaccination", imaging: "Bilddiagnostik" };

/** Sends the patient, optionally one record, to a doctor colleague in the clinic. */
export function ConsultDialog({ patient, records, demo, onClose, onSent }: {
  patient: { id: string; display_name: string; identity_label: string };
  records: ClinicalRecord[];
  demo: boolean;
  onClose: () => void;
  onSent: (colleague: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [colleagues, setColleagues] = useState<Colleague[] | null>(null);
  const [to, setTo] = useState("");
  const [record, setRecord] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);
  useEffect(() => {
    if (demo) {
      setColleagues([{ user_id: "00000000-0000-4000-8000-0000000000c1", display_name: "Dr. Berg" }]);
      return;
    }
    post({ action: "consultation", op: "colleagues" })
      .then((c: Colleague[]) => setColleagues(c))
      .catch((e: Error) => { setColleagues([]); setError(e.message); });
  }, [demo]);
  const choices = records.filter((r) => !r.annulled_at && !r.superseded_at);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!to || !message.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (!demo) await post({ action: "consultation", op: "send", patientId: patient.id, to, recordId: record || null, message: message.trim() });
      onSent(colleagues?.find((c) => c.user_id === to)?.display_name ?? "kollegan");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <dialog ref={ref} className="dialog consult-dialog" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="dialog-heading">
        <h2>Konsultera med en kollega</h2>
        <button className="icon-button" aria-label="Stäng" onClick={onClose}><X size={20} /></button>
      </div>
      <div className="dialog-patient">{patient.display_name} · {patient.identity_label}</div>
      <form onSubmit={submit}>
        <label>
          Kollega
          <select required value={to} onChange={(e) => setTo(e.target.value)} disabled={!colleagues?.length}>
            <option value="">{colleagues === null ? "Hämtar…" : colleagues.length ? "Välj läkare" : "Inga andra läkare i kliniken"}</option>
            {colleagues?.map((c) => <option key={c.user_id} value={c.user_id}>{c.display_name}</option>)}
          </select>
        </label>
        <label>
          Gäller
          <select value={record} onChange={(e) => setRecord(e.target.value)}>
            <option value="">Hela patienten</option>
            {choices.map((r) => (
              <option key={r.id} value={r.id}>
                {kindLabel[r.kind] ?? r.kind}: {String((r.payload as { title?: string }).title ?? "")}{r.status === "draft" ? " (utkast)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Meddelande
          <textarea required rows={5} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="Beskriv frågan. Kollegan ser patienten och kan öppna journalen." />
        </label>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>Avbryt</button>
          <button type="submit" className="button" disabled={busy || !to || !message.trim()}><Send size={15} /> Skicka</button>
        </div>
      </form>
    </dialog>
  );
}

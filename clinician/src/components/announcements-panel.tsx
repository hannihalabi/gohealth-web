"use client";
import { Archive, Megaphone, Send } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { HomeAnnouncement } from "@/lib/clinician-home";
import "./clinician-home.css";

async function post(body: unknown) {
  const r = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Åtgärden kunde inte genomföras.");
  return data;
}
const when = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Stockholm" });

/** Administrator: messages shown on every staff member's start page in the clinician portal. */
export function AnnouncementsPanel({ organizationId, demo }: { organizationId: string; demo: boolean }) {
  const [items, setItems] = useState<HomeAnnouncement[] | null>(demo ? [] : null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    if (demo || !organizationId) return;
    try {
      setItems(await post({ action: "announcements", organizationId, op: "list" }));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [demo, organizationId]);
  useEffect(() => { void load(); }, [load]);
  async function publish(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // The chosen day is shown through its end, in the administrator's local time.
      const expiresAt = until ? new Date(`${until}T23:59:00`).toISOString() : null;
      if (demo) {
        setItems((list) => [{ id: crypto.randomUUID(), title: title.trim(), body: body.trim(), created_at: new Date().toISOString(), author: "Du", expires_at: expiresAt, active: true }, ...(list ?? [])]);
      } else {
        setItems(await post({ action: "announcements", organizationId, op: "post", title: title.trim(), body: body.trim(), expiresAt }));
      }
      setTitle(""); setBody(""); setUntil("");
      setNotice("Meddelandet visas nu för all personal.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function archive(id: string) {
    setError("");
    try {
      if (demo) setItems((list) => (list ?? []).filter((a) => a.id !== id));
      else setItems(await post({ action: "announcements", organizationId, op: "archive", id }));
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div className="home-grid">
      <section className="home-card">
        <header>
          <span className="home-card-icon"><Megaphone size={18} /></span>
          <div><h2>Nytt meddelande</h2><p>Visas på översikten för alla läkare och sjuksköterskor i kliniken.</p></div>
        </header>
        <form onSubmit={publish}>
          <label>Rubrik<input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>Meddelande<textarea required rows={6} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          <label>Visas till och med (valfritt)<input type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} /></label>
          {error && <div className="alert error" role="alert">{error}</div>}
          {notice && <div className="alert success" role="status">{notice}</div>}
          <div className="dialog-actions">
            <button className="button" disabled={busy || !title.trim() || !body.trim()}><Send size={15} /> Publicera</button>
          </div>
        </form>
      </section>
      <section className="home-card">
        <header>
          <span className="home-card-icon"><Megaphone size={18} /></span>
          <div><h2>Publicerade meddelanden</h2><p>Arkiverade meddelanden försvinner från personalens översikt.</p></div>
        </header>
        {!items ? <p className="home-empty">Hämtar…</p> : !items.length ? <p className="home-empty">Inga publicerade meddelanden.</p> : (
          <ul className="home-notes">
            {items.map((a) => (
              <li key={a.id}>
                <strong>{a.title}</strong>
                <p>{a.body}</p>
                <small>
                  {a.author} · {when(a.created_at)}
                  {a.expires_at ? ` · ${a.active === false ? "utgånget" : "visas till " + when(a.expires_at)}` : ""}
                </small>
                <div className="home-consult-actions">
                  <button className="button secondary" onClick={() => void archive(a.id)}><Archive size={14} /> Arkivera</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

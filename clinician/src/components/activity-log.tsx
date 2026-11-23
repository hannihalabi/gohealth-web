"use client";
import { ChevronDown, ChevronRight, Download, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RoleBadge } from "@/components/role-badge";
import { activityCategories, activityLabel, deviceName, toCsv, type ActivityCategory } from "@/lib/activity";
import type { Member } from "@/lib/administration";
import "./activity-log.css";

type Account = {
  user_id: string; display_name: string; roles: string[]; active: boolean; email: string;
  last_sign_in_at: string | null; last_activity_at: string | null; events: number; sessions: number;
};
type ActivityEvent = {
  id: string; at: string; actor_id: string; actor: string | null; roles: string[] | null;
  category: ActivityCategory; action: string; patient_id: string | null; patient: string | null;
  record_id: string | null; record: { kind: string; title: string | null; status: string } | null;
  details: Record<string, unknown> | null;
};
type Cursor = { before: string; before_id: string } | null;

async function post(body: unknown) {
  const r = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Aktiviteten kunde inte hämtas.");
  return data;
}
const stamp = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function ago(iso: string | null) {
  if (!iso) return "Ingen aktivitet";
  const m = (Date.now() - Date.parse(iso)) / 60000;
  if (m < 1) return "Aktiv nu";
  if (m < 60) return `${Math.round(m)} min sedan`;
  if (m < 1440) return `${Math.round(m / 60)} tim sedan`;
  return `${Math.round(m / 1440)} dagar sedan`;
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
const kindNames: Record<string, string> = { lab: "Provsvar", vaccination: "Vaccination", imaging: "Bilddiagnostik" };
const periods = [[1, "24 timmar"], [7, "7 dagar"], [30, "30 dagar"], [90, "90 dagar"], [366, "1 år"]] as const;

function demoData(members: Member[]) {
  const now = Date.now();
  const staff = members.filter((m) => m.active);
  const accounts: Account[] = staff.map((m, i) => ({
    user_id: m.user_id, display_name: m.display_name, roles: [m.role], active: m.active, email: m.email,
    last_sign_in_at: new Date(now - (i + 1) * 3600000).toISOString(), last_activity_at: new Date(now - (i + 1) * 600000).toISOString(),
    events: 4 - Math.min(i, 3), sessions: 1,
  }));
  const events: ActivityEvent[] = staff.flatMap((m, i) => [
    { id: `d${i}a`, at: new Date(now - (i + 1) * 600000).toISOString(), actor_id: m.user_id, actor: m.display_name, roles: [m.role], category: m.role === "admin" ? "admin" : "journal",
      action: m.role === "admin" ? "administration.member" : "patient.open", patient_id: m.role === "admin" ? null : "demo-p", patient: m.role === "admin" ? null : "Alex Lind",
      record_id: null, record: null, details: m.role === "admin" ? { role: "nurse", subject: "Elin · testsjuksköterska" } : null },
    { id: `d${i}b`, at: new Date(now - (i + 1) * 3600000).toISOString(), actor_id: m.user_id, actor: m.display_name, roles: [m.role], category: "login",
      action: "auth.session", patient_id: null, patient: null, record_id: null, record: null,
      details: { user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36", ip: "192.0.2." + (i + 10), active: true } },
  ]);
  return { accounts, events: events.sort((a, b) => b.at.localeCompare(a.at)) };
}

/** Activity per account, for log review and tracing when patient safety must be re-established. */
export function ActivityLog({ organizationId, demo, members }: { organizationId: string; demo: boolean; members: Member[] }) {
  const demoSet = useMemo(() => (demo ? demoData(members) : null), [demo, members]);
  const [accounts, setAccounts] = useState<Account[] | null>(demoSet?.accounts ?? null);
  const [account, setAccount] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [category, setCategory] = useState<"all" | ActivityCategory>("all");
  const [routine, setRoutine] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[] | null>(demoSet?.events ?? null);
  const [next, setNext] = useState<Cursor>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadAccounts = useCallback(async () => {
    if (demo) return;
    try {
      const r = await post({ action: "activity", organizationId, mode: "accounts", days });
      setAccounts(r.accounts);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [demo, organizationId, days]);

  const loadEvents = useCallback(async (cursor: Cursor = null) => {
    if (demo) {
      setEvents((demoSet?.events ?? []).filter((e) => (!account || e.actor_id === account) && (category === "all" || e.category === category)));
      return;
    }
    setBusy(true);
    try {
      const r = await post({ action: "activity", organizationId, mode: "events", account, category, days, routine, ...(cursor ?? {}) });
      setEvents((prev) => (cursor ? [...(prev ?? []), ...r.events] : r.events));
      setNext(r.next ?? null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [demo, demoSet, organizationId, account, category, days, routine]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useEffect(() => { setOpen(null); void loadEvents(); }, [loadEvents]);

  const selected = accounts?.find((a) => a.user_id === account) ?? null;
  const shown = (accounts ?? []).filter((a) => `${a.display_name} ${a.email}`.toLowerCase().includes(query.toLowerCase()));
  const total = (accounts ?? []).reduce((n, a) => n + Number(a.events), 0);

  function exportCsv() {
    const rows = [["Tid", "Konto", "Roll", "Kategori", "Händelse", "Åtgärdskod", "Patient", "Post", "Detaljer"],
      ...(events ?? []).map((e) => [stamp(e.at), e.actor ?? e.actor_id, (e.roles ?? []).join(" "), activityCategories[e.category],
        activityLabel(e.action), e.action, e.patient ?? "", e.record ? `${kindNames[e.record.kind] ?? e.record.kind}: ${e.record.title ?? ""}` : "",
        e.details ? JSON.stringify(e.details) : ""])];
    const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aktivitet-${selected ? selected.display_name.replace(/\s+/g, "-") : "alla"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="act" aria-label="Aktivitet per konto">
      <aside className="act-accounts">
        <header>
          <h2>Konton</h2>
          <label className="act-search"><Search size={14} /><input aria-label="Sök konto" placeholder="Sök namn eller e-post" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        </header>
        <ul>
          <li>
            <button className={"act-account" + (account === null ? " selected" : "")} onClick={() => setAccount(null)}>
              <span className="act-avatar all">∑</span>
              <span className="act-account-main"><strong>Alla konton</strong><small>{accounts ? `${total} händelser · ${days === 366 ? "1 år" : days + " d"}` : "Hämtar…"}</small></span>
            </button>
          </li>
          {shown.map((a) => (
            <li key={a.user_id}>
              <button className={"act-account" + (account === a.user_id ? " selected" : "") + (a.active ? "" : " inactive")} onClick={() => setAccount(a.user_id)}>
                <span className="act-avatar">{initials(a.display_name)}</span>
                <span className="act-account-main">
                  <strong>{a.display_name}</strong>
                  <span className="act-badges">{a.roles.map((r) => <RoleBadge key={r} role={r} small />)}</span>
                  <small>{ago(a.last_activity_at)} · {a.events} händelser{a.sessions ? ` · ${a.sessions} ${a.sessions === 1 ? "session" : "sessioner"}` : ""}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="act-main">
        <header className="act-head">
          <div>
            <h2>{selected ? selected.display_name : "Alla konton"}</h2>
            <p>
              {selected
                ? <>{selected.email} · senaste inloggning {selected.last_sign_in_at ? stamp(selected.last_sign_in_at) : "okänd"}{!selected.active && " · inaktiv"}</>
                : "All personal och alla administratörer i kliniken. Bara metadata visas, aldrig journalinnehåll."}
            </p>
          </div>
          <div className="act-tools">
            <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {periods.map(([d, label]) => <option key={d} value={d}>{label}</option>)}
            </select>
            <button className="act-icon" aria-label="Uppdatera" disabled={busy} onClick={() => { void loadAccounts(); void loadEvents(); }}><RefreshCw size={15} /></button>
            <button className="act-icon" aria-label="Exportera CSV" title="Exportera det som visas som CSV" disabled={!events?.length} onClick={exportCsv}><Download size={15} /></button>
          </div>
        </header>
        <div className="act-filters">
          <div role="tablist" aria-label="Kategori">
            {([["all", "Alla"], ["journal", "Journal"], ["admin", "Administration"], ["login", "Inloggningar"]] as const).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={category === id} className={category === id ? "active" : ""} onClick={() => setCategory(id)}>
                {id !== "all" && <i className={"act-dot " + id} />}{label}
              </button>
            ))}
          </div>
          <label className="act-routine"><input type="checkbox" checked={routine} onChange={(e) => setRoutine(e.target.checked)} /> Visa rutinhändelser</label>
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="act-table-wrap">
          <table className="act-table">
            <thead>
              <tr><th aria-label="Visa detaljer" /><th>Tid</th>{!selected && <th>Konto</th>}<th>Händelse</th><th>Patient</th><th>Detaljer</th></tr>
            </thead>
            <tbody>
              {(events ?? []).map((e) => {
                const expanded = open === e.id;
                const device = e.category === "login" ? deviceName(e.details?.user_agent as string | undefined) : "";
                return [
                  <tr key={e.id} className={expanded ? "is-open" : ""} onClick={() => setOpen(expanded ? null : e.id)}>
                    <td className="act-chevron">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td className="act-time">{stamp(e.at)}</td>
                    {!selected && <td className="act-who">{e.actor ?? "—"}</td>}
                    <td><i className={"act-dot " + e.category} /> {activityLabel(e.action)}</td>
                    <td>{e.patient ?? <span className="act-muted">—</span>}</td>
                    <td className="act-detail">
                      {e.record ? `${kindNames[e.record.kind] ?? e.record.kind}${e.record.title ? ": " + e.record.title : ""}`
                        : e.category === "login" ? [device, e.details?.ip, e.details?.active ? "aktiv" : "avslutad"].filter(Boolean).join(" · ")
                        : typeof e.details?.subject === "string" ? String(e.details.subject) : ""}
                    </td>
                  </tr>,
                  expanded && (
                    <tr key={e.id + "-x"} className="act-expanded">
                      <td colSpan={selected ? 5 : 6}>
                        <dl>
                          <dt>Tid</dt><dd>{new Date(e.at).toISOString()}</dd>
                          <dt>Konto</dt><dd>{e.actor ?? "—"} <code>{e.actor_id}</code></dd>
                          <dt>Åtgärd</dt><dd><code>{e.action}</code></dd>
                          {e.patient_id && <><dt>Patient</dt><dd>{e.patient} <code>{e.patient_id}</code></dd></>}
                          {e.record_id && <><dt>Post</dt><dd>{e.record ? `${kindNames[e.record.kind] ?? e.record.kind} · ${e.record.status}` : ""} <code>{e.record_id}</code></dd></>}
                          {e.details && Object.entries(e.details).map(([k, v]) => <span key={k} className="act-kv"><dt>{k}</dt><dd><code>{typeof v === "string" ? v : JSON.stringify(v)}</code></dd></span>)}
                          <dt>Händelse-id</dt><dd><code>{e.id}</code></dd>
                        </dl>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
          {events && !events.length && <p className="act-empty">Inga händelser i vald period.</p>}
          {!events && <p className="act-empty">Hämtar…</p>}
        </div>
        {next && <button className="button secondary act-more" disabled={busy} onClick={() => void loadEvents(next)}>Visa äldre händelser</button>}
        <p className="act-foot">
          Rutinhändelser, som att öppna översikten eller inkorgen, döljs som standard. Inloggningar visas för de sessioner som finns kvar. Varje granskning här loggas.
        </p>
      </div>
    </section>
  );
}

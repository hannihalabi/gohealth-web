"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Activity, Check, Database, Globe2, LayoutDashboard, RefreshCw, ShieldCheck, Smartphone, Stethoscope, Users, Zap } from "lucide-react";
import { invitationState, roleNames, type AdministrationData } from "@/lib/administration";
import { demoOverview, integrationPositions, type Integration, type OverviewData } from "@/lib/overview";
import { DatabaseHealthPanel } from "./database-health";
import { AdminSummary } from "./admin-summary";
import "./system-overview.css";

const icons = { admin: LayoutDashboard, clinician: Stethoscope, app: Smartphone, website: Globe2, service: Activity };
function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join("");
}

export function SystemOverview({ organizationId, demo, administration, onStaff }: {
  organizationId: string;
  demo: boolean;
  administration: AdministrationData | null;
  onStaff: () => void;
}) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [memberPortal, setMemberPortal] = useState<"clinician" | "admin">("clinician");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(true);
  const [showDatabase, setShowDatabase] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const demoSource = useRef(administration);
  demoSource.current = administration;

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    const generation = ++requestId.current;
    // Never retain identities across organisation, portal or page changes.
    setData(null);
    setError("");
    async function read() {
      if (disposed || inFlight) return;
      inFlight = true;
      setBusy(true);
      try {
        let next: OverviewData;
        if (demo) {
          const source = demoSource.current;
          if (!source) return;
          next = demoOverview(source.members, source.invitations.filter((i) => invitationState(i) === "Väntar på aktivering").length, memberPortal, offset);
        } else {
          const response = await fetch("/api/admin", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "overview", organizationId, memberPortal, memberOffset: offset }),
            cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          });
          next = await response.json();
          if (!response.ok) {
            if (!disposed && generation === requestId.current && [401, 403].includes(response.status)) setData(null);
            throw new Error((next as unknown as { error: string }).error || "Översikten kunde inte hämtas.");
          }
        }
        if (!disposed && generation === requestId.current) {
          if (offset > 0 && offset >= next.memberTotal) {
            setOffset(Math.max(0, Math.floor((next.memberTotal - 1) / next.memberLimit) * next.memberLimit));
            return;
          }
          setData(next);
          setError("");
          setSelectedId((id) => id && next.integrations.some((i) => i.id === id) ? id : next.integrations.find((i) => i.kind === memberPortal)?.id ?? null);
        }
      } catch (e) {
        if (!disposed && generation === requestId.current) setError((e as Error).message);
      } finally {
        inFlight = false;
        if (!disposed && generation === requestId.current) setBusy(false);
      }
    }
    void read();
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 30000);
    const resume = () => { if (!document.hidden) void read(); };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [organizationId, memberPortal, offset, refresh, demo, administration]);

  const selected = data?.integrations.find((i) => i.id === selectedId);
  function select(integration: Integration) {
    setShowDatabase(false);
    setSelectedId(integration.id);
    if (integration.kind === "admin" || integration.kind === "clinician") {
      setMemberPortal(integration.kind);
      setOffset(0);
    }
  }

  return <SystemOverviewView data={data} selectedId={showDatabase ? null : selected?.id ?? null} busy={busy} error={error} demo={demo}
    showDatabase={showDatabase} organizationId={organizationId} administration={administration} onDatabase={() => setShowDatabase(true)} onSelect={select} onRefresh={() => setRefresh((r) => r + 1)} onPage={setOffset} onStaff={onStaff} />;
}

export function SystemOverviewView({ data, selectedId, busy, error, demo, showDatabase = false, organizationId = "", administration = null, onDatabase = () => {}, onSelect, onRefresh, onPage, onStaff }: {
  data: OverviewData | null; selectedId: string | null; busy: boolean; error: string; demo: boolean;
  showDatabase?: boolean; organizationId?: string; administration?: AdministrationData | null; onDatabase?: () => void;
  onSelect: (integration: Integration) => void; onRefresh: () => void; onPage: (offset: number) => void; onStaff: () => void;
}) {
  const selected = data?.integrations.find((i) => i.id === selectedId);
  const positions = integrationPositions(data?.integrations.length ?? 0);
  const connected = data?.integrations.filter((i) => i.connected).length;
  const offset = data?.memberOffset ?? 0;
  return <section className="system-overview" aria-label="Systemöversikt">
    <div className="overview-heading">
      <div />
      <button className="button secondary" disabled={busy} onClick={onRefresh}><RefreshCw size={16} className={busy ? "overview-spinning" : ""} />Uppdatera</button>
    </div>
    <div className="overview-metrics">
      <div><span className="overview-metric-icon"><Database size={19} /></span><div><strong>{data ? connected : "—"}</strong><span>Anslutna system</span></div></div>
      <div><span className="overview-metric-icon"><Users size={19} /></span><div><strong>{data ? data.counts.clinician : "—"}</strong><span>Aktiva kliniska behörigheter</span></div></div>
      <div><span className="overview-metric-icon"><ShieldCheck size={19} /></span><div><strong>{data ? data.counts.pending : "—"}</strong><span>Väntar på aktivering</span></div></div>
    </div>
    {error && <div className="alert error" role="alert">{error} {data ? "Bilden visar senast hämtade uppgifter och kan vara inaktuell." : "Ingen aktuell systembild kan visas."}</div>}
    <div className="overview-workbench" aria-busy={busy}>
      <div className={"overview-map " + (error ? "overview-map-stale" : "")}>
        <div className="overview-map-heading"><span><span className={"overview-signal " + (error || !data ? "is-stale" : "")} />{demo ? "Demonstrationsbild" : "Systemkarta"}</span></div>
        {!data ? <div className="overview-map-loading" role="status"><Database size={32} /><p>{busy ? "Hämtar systembilden…" : "Systembilden är inte tillgänglig."}</p></div> : <>
          <div className="overview-scene">
            <svg className="overview-connections" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
              {data.integrations.map((integration, index) => {
                const p = positions[index];
                return <g key={integration.id} className={(integration.connected ? "" : "is-satellite ") + (integration.id === selectedId ? "is-selected" : "")}>
                  <path d={`M 500 300 L ${p.x * 10} ${p.y * 6}`} />
                </g>;
              })}
            </svg>
            <button type="button" className={"overview-core" + (showDatabase ? " is-selected" : "")} aria-pressed={showDatabase} aria-label="Supabase, central databas. Visa databasens status" onClick={onDatabase}>
              <div className="overview-core-icon"><Database size={30} /></div>
              <strong>Supabase</strong><span>Central databas</span>
            </button>
            {data.integrations.map((integration, index) => {
              const Icon = icons[integration.kind];
              return <button key={integration.id} className={"overview-node " + (integration.connected ? "is-connected " : "is-satellite ") + (selectedId === integration.id ? "is-selected" : "")}
                style={{ "--node-x": `${positions[index].x}%`, "--node-y": `${positions[index].y}%` } as CSSProperties}
                aria-pressed={selectedId === integration.id} onClick={() => onSelect(integration)}>
                <span className="overview-node-icon"><Icon size={24} /></span>
                <strong>{integration.name}</strong>
                <span className="overview-node-status">{integration.connected ? <Check size={12} /> : <span className="overview-satellite-dot" />}{integration.connected ? "Ansluten" : "Ej ansluten"}</span>
                {(integration.kind === "clinician" || integration.kind === "admin") && <span className="overview-node-users"><Users size={13} />{data.counts[integration.kind]} {data.counts[integration.kind] === 1 ? "aktiv behörighet" : "aktiva behörigheter"}</span>}
              </button>;
            })}
          </div>
          <div className="overview-map-footer"><span><i />Databasanslutning</span><span><i />Fristående satellit</span></div>
        </>}
      </div>
      <aside className="overview-detail" aria-label="Valt system">
        {showDatabase ? <DatabaseHealthPanel organizationId={organizationId} demo={demo} /> : selected && data ? <>
          <div className="overview-detail-icon">{(() => { const Icon = icons[selected.kind]; return <Icon size={24} />; })()}</div>
          <h2>{selected.name}</h2>
          <div className={"overview-connection-state " + (!selected.connected ? "is-satellite" : "")}><span className="overview-signal" />{selected.connected ? "Ansluten till Supabase" : "Fristående satellit"}</div>
          {selected.kind === "admin" && <AdminSummary organizationId={organizationId} demo={demo} administration={administration} />}
          {selected.kind === "admin" || selected.kind === "clinician" ? <>
            <div className="overview-users-heading"><h3>Användare</h3><span>{data.memberTotal}</span></div>
            <ul className="overview-users">{data.members.map((member) => <li key={member.user_id + member.role}><span className="overview-user-avatar">{initials(member.display_name)}</span><div><strong>{member.display_name}</strong><span>{roleNames[member.role]} · {member.active ? "Aktiv" : "Inaktiv"}</span><small>{member.email}</small></div></li>)}</ul>
            {!data.members.length && <p className="overview-empty">Inga användare finns på den här sidan.</p>}
            {(data.memberTotal > data.memberLimit || offset > 0) && <div className="overview-pagination"><button disabled={!offset || busy} onClick={() => onPage(Math.max(0, offset - data.memberLimit))}>Föregående</button><span>{offset + 1}–{offset + data.members.length} av {data.memberTotal}</span><button disabled={offset + data.members.length >= data.memberTotal || busy} onClick={() => onPage(offset + data.memberLimit)}>Nästa</button></div>}
            <button className="button secondary overview-manage" onClick={onStaff}><Users size={16} />Hantera personal</button>
          </> : <div className="overview-detail-note"><Database size={19} /><p>{selected.connected ? "Delar GoHealths databas." : "Ingen databasanslutning."}</p></div>}
        </> : <div className="overview-empty"><Activity size={26}/><p>Välj ett system</p></div>}
      </aside>
    </div>
    <div className="overview-freshness"><span><RefreshCw size={14}/>{data ? `${demo ? "Demodata" : "Hämtat"} ${new Date(data.checkedAt).toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Väntar på aktuella uppgifter"}</span></div>
  </section>;
}

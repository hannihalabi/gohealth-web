"use client";
import { Activity, Database, ExternalLink, HardDrive, Timer, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  assessHealth, cacheHitRatio, connectionShare, formatBytes, formatDuration, type DatabaseHealth,
} from "@/lib/database-health";

async function fetchHealth(organizationId: string, signal: AbortSignal): Promise<DatabaseHealth> {
  const response = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "database", organizationId }),
    cache: "no-store",
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || "Databasens status kunde inte hämtas.");
  return data;
}

function Meter({ label, value, text, pct, level }: { label: string; value: string; text?: string; pct: number; level: "ok" | "warn" | "bad" }) {
  return (
    <div className="dh-meter">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className={"dh-bar dh-" + level} role="img" aria-label={`${label}: ${value}`}>
        <i style={{ width: Math.min(100, Math.max(2, pct * 100)) + "%" }} />
      </div>
      {text && <small>{text}</small>}
    </div>
  );
}

export function DatabaseHealthPanel({ organizationId, demo }: { organizationId: string; demo: boolean }) {
  const [data, setData] = useState<DatabaseHealth | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(!demo);
  const generation = useRef(0);

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    const current = ++generation.current;
    async function read() {
      try {
        const next = await fetchHealth(organizationId, controller.signal);
        if (current === generation.current) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (current === generation.current && !controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (current === generation.current) setBusy(false);
      }
    }
    void read();
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [organizationId, demo]);

  if (demo)
    return (
      <div className="dh">
        <div className="dh-head"><span className="dh-icon"><Database size={22} /></span><h2>Supabase</h2></div>
        <p className="dh-note">Demonstrationsmiljön är inte ansluten till någon databas.</p>
      </div>
    );
  if (!data)
    return (
      <div className="dh">
        <div className="dh-head"><span className="dh-icon"><Database size={22} /></span><h2>Supabase</h2></div>
        {error ? <p className="alert error" role="alert">{error}</p> : <p className="dh-note" role="status">{busy ? "Hämtar databasens status…" : ""}</p>}
      </div>
    );

  const verdict = assessHealth(data);
  const share = connectionShare(data);
  const cache = cacheHitRatio(data);
  const tx = data.connections.longestTransactionSeconds;
  const uptime = (Date.now() - new Date(data.startedAt).getTime()) / 1000;
  const dead = data.topTables[0];
  return (
    <div className="dh">
      <div className="dh-head">
        <span className="dh-icon"><Database size={22} /></span>
        <div>
          <h2>Supabase</h2>
          <p>Postgres {data.version.split(" ")[0]} · uppe i {formatDuration(uptime)}</p>
        </div>
      </div>
      <div className={"dh-verdict dh-" + verdict.level} role="status">
        <strong>{verdict.title}</strong>
        {verdict.reasons.length > 0 && (
          <ul>{verdict.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        )}
      </div>
      {error && <p className="alert error" role="alert">{error} Visar senast hämtade värden.</p>}
      <Meter
        label="Anslutningar"
        value={`${data.connections.used} / ${data.connections.max}`}
        pct={share}
        level={share >= 0.9 ? "bad" : share >= 0.7 ? "warn" : "ok"}
        text={`${data.connections.active} aktiva · ${data.connections.idle} lediga${data.connections.idleInTransaction ? ` · ${data.connections.idleInTransaction} öppna i transaktion` : ""}`}
      />
      <Meter
        label="Cacheträff"
        value={cache === null ? "För lite trafik" : `${(cache * 100).toFixed(1)} %`}
        pct={cache ?? 1}
        level={cache === null ? "ok" : cache < 0.9 ? "bad" : cache < 0.95 ? "warn" : "ok"}
        text="Andel läsningar som tas från minnet"
      />
      <Meter
        label="Längsta transaktion"
        value={formatDuration(tx)}
        pct={Math.min(1, tx / 1800)}
        level={tx > 1800 ? "bad" : tx > 300 ? "warn" : "ok"}
      />
      <div className="dh-grid">
        <div><HardDrive size={16} /><strong>{formatBytes(data.database.sizeBytes)}</strong><span>Databasstorlek</span></div>
        <div><Activity size={16} /><strong>{data.database.tables}</strong><span>Tabeller</span></div>
        <div><HardDrive size={16} /><strong>{formatBytes(data.storage.bytes)}</strong><span>{data.storage.objects} filer i lagring</span></div>
        <div><Users size={16} /><strong>{data.users}</strong><span>Inloggningskonton</span></div>
        <div><Timer size={16} /><strong>{data.database.deadlocks}</strong><span>Låsningar</span></div>
        <div><Activity size={16} /><strong>{data.database.rollbacks.toLocaleString("sv-SE")}</strong><span>Återrullningar</span></div>
      </div>
      {data.topTables.length > 0 && (
        <div className="dh-tables">
          <h3>Största tabeller</h3>
          <ul>
            {data.topTables.map((t) => (
              <li key={t.name}>
                <span>{t.name}</span>
                <b>{formatBytes(t.size_bytes)}</b>
              </li>
            ))}
          </ul>
          {dead && <small>Siffrorna gäller storlek och inkluderar index.</small>}
        </div>
      )}
      <p className="dh-note">
        CPU, minne och diskutrymme visas inte härifrån utan i Supabase.
      </p>
      {data.dashboardUrl && (
        <a className="button secondary dh-link" href={data.dashboardUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={15} /> Öppna i Supabase
        </a>
      )}
      <small className="dh-time">Uppdaterad {new Date(data.checkedAt).toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm" })}</small>
    </div>
  );
}

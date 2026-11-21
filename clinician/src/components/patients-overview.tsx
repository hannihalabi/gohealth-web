"use client";
import { Check, CreditCard, Globe, Smartphone, UserCheck, Users, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PipelineData } from "@/lib/pipeline";

const empty: PipelineData = {
  registered: 0,
  signupTotal: 0,
  signups: [],
  applicationTotal: 0,
  applications: [],
  weeks: [],
};
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });

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

export function PatientsOverview({
  organizationId,
  demo,
  registeredFallback,
}: {
  organizationId: string;
  demo: boolean;
  registeredFallback: number;
}) {
  const [data, setData] = useState<PipelineData | null>(demo ? { ...empty, registered: registeredFallback } : null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState("");
  const load = useCallback(async () => {
    if (demo || !organizationId) return;
    try {
      setData(await post({ action: "pipeline", organizationId }));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [demo, organizationId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function decide(
    kind: "signup" | "application",
    id: string,
    decision: string,
    revision: number,
  ) {
    setBusy(true);
    try {
      await post({
        action: "pipelineDecision",
        organizationId,
        kind,
        id,
        decision,
        revision,
        identityAttested: decision === "approve",
      });
      setConfirm("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return error ? (
      <div className="alert error" role="alert">
        {error}
      </div>
    ) : (
      <p role="status">Hämtar…</p>
    );
  const steps = [
    { label: "Ansökan", sub: "Hemläkare.se", n: data.applicationTotal, Icon: Globe },
    { label: "Onboarding", sub: "Väntar på godkännande", n: data.signupTotal, Icon: Smartphone },
    { label: "Registrerade", sub: "Godkända", n: data.registered, Icon: UserCheck },
  ];
  const max = Math.max(1, ...steps.map((s) => s.n));
  return (
    <div className="pt">
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      <div className="pt-tiles">
        <Tile Icon={Users} value={data.registered} label="Registrerade patienter" />
        <Tile Icon={Smartphone} value={data.signupTotal} label="Väntar på godkännande" alert={data.signupTotal > 0} />
        <Tile Icon={Globe} value={data.applicationTotal} label="Nya ansökningar" alert={data.applicationTotal > 0} />
        <Tile Icon={CreditCard} value="—" label="MRR · Stripe" />
      </div>
      <div className="pt-columns">
        <section className="panel pt-card">
          <h2>Flöde</h2>
          <div className="pt-funnel">
            {steps.map(({ label, sub, n, Icon }) => (
              <div key={label} className="pt-step">
                <span className="pt-step-icon">
                  <Icon size={18} />
                </span>
                <span className="pt-step-label">
                  {label}
                  <small>{sub}</small>
                </span>
                <span className="pt-bar">
                  <i style={{ width: (n / max) * 100 + "%" }} />
                </span>
                <b>{n}</b>
              </div>
            ))}
          </div>
        </section>
        <section className="panel pt-card">
          <h2>Nya patienter per vecka</h2>
          <Weeks weeks={data.weeks} />
        </section>
      </div>
      <section className="panel pt-card">
        <h2>
          Väntar på godkännande
          <span className="pt-count">{data.signupTotal}</span>
        </h2>
        {data.signups.length ? (
          <ul className="pt-rows">
            {data.signups.map((s) => (
              <li key={s.id}>
                <span>
                  <strong>{s.display_name}</strong>
                  <small>
                    {s.identity_label} · {date(s.created_at)}
                  </small>
                </span>
                <span className="pt-actions">
                  {confirm === s.id ? (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => decide("signup", s.id, "approve", s.revision)}
                    >
                      <Check size={16} />
                      Identiteten är kontrollerad
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => setConfirm(s.id)}
                    >
                      Godkänn
                    </button>
                  )}
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => decide("signup", s.id, "reject", s.revision)}
                  >
                    <X size={16} />
                    Avslå
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pt-muted">Inga väntande</p>
        )}
      </section>
      <section className="panel pt-card">
        <h2>
          Ansökningar från hemsidan
          <span className="pt-count">{data.applicationTotal}</span>
        </h2>
        {data.applications.length ? (
          <ul className="pt-rows">
            {data.applications.map((a) => (
              <li key={a.id}>
                <span>
                  <strong>{a.name}</strong>
                  <small>
                    {a.email} · {date(a.created_at)}
                  </small>
                  {a.message && <em>{a.message}</em>}
                </span>
                <span className="pt-actions">
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => decide("application", a.id, "handled", a.revision)}
                  >
                    Hanterad
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => decide("application", a.id, "dismissed", a.revision)}
                  >
                    Avfärda
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pt-muted">Inga ansökningar</p>
        )}
      </section>
    </div>
  );
}
function Tile({
  Icon,
  value,
  label,
  alert,
}: {
  Icon: typeof Users;
  value: ReactNode;
  label: string;
  alert?: boolean;
}) {
  return (
    <div className={"pt-tile" + (alert ? " is-alert" : "")}>
      <Icon size={20} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
function Weeks({ weeks }: { weeks: PipelineData["weeks"] }) {
  if (!weeks.length) return <p className="pt-muted">Inga nya patienter de senaste 12 veckorna</p>;
  const max = Math.max(1, ...weeks.map((w) => w.registered));
  return (
    <div className="pt-weeks">
      {weeks.map((w) => (
        <div key={w.week} title={w.week + ": " + w.registered}>
          <b>{w.registered}</b>
          <i style={{ height: (w.registered / max) * 100 + "%" }} />
          <small>v{weekNumber(w.week)}</small>
        </div>
      ))}
    </div>
  );
}
function weekNumber(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - y.getTime()) / 86400000 + 1) / 7);
}

"use client";
import { CreditCard, Globe, Smartphone, UserCheck, Users } from "lucide-react";
import type { ReactNode } from "react";

// Not stored in the database yet. Pass real rows when onboarding, the website
// form and Stripe are connected; until then every list shows its empty state.
export type PendingPatient = { id: string; name: string; since: string };
export type Lead = { id: string; name: string; since: string };
export type PatientsOverviewData = {
  registered: number;
  pending?: PendingPatient[];
  leads?: Lead[];
  mrr?: { amount: number; history: number[] } | null;
};

const date = (iso: string) =>
  new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });

export function PatientsOverview({
  registered,
  pending = [],
  leads = [],
  mrr = null,
}: PatientsOverviewData) {
  const steps = [
    { label: "Ansökan", sub: "Hemläkare.se", n: leads.length, Icon: Globe },
    { label: "Onboarding", sub: "Klar i appen", n: pending.length, Icon: Smartphone },
    { label: "Registrerade", sub: "Godkända", n: registered, Icon: UserCheck },
  ];
  const max = Math.max(1, ...steps.map((s) => s.n));
  return (
    <div className="pt">
      <div className="pt-tiles">
        <Tile Icon={Users} value={registered} label="Registrerade patienter" />
        <Tile
          Icon={Smartphone}
          value={pending.length}
          label="Väntar på godkännande"
          alert={pending.length > 0}
        />
        <Tile Icon={Globe} value={leads.length} label="Nya ansökningar" />
        <Tile
          Icon={CreditCard}
          value={mrr ? mrr.amount.toLocaleString("sv-SE") + " kr" : "—"}
          label="MRR"
        />
      </div>
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
      <div className="pt-columns">
        <List title="Väntar på godkännande" empty="Inga väntande" rows={pending} />
        <List title="Ansökningar från hemsidan" empty="Inga ansökningar" rows={leads} />
      </div>
      <section className="panel pt-card">
        <h2>MRR</h2>
        {mrr ? (
          <div className="pt-mrr">
            <strong>{mrr.amount.toLocaleString("sv-SE")} kr</strong>
            <Sparkline values={mrr.history} />
          </div>
        ) : (
          <div className="pt-mrr pt-muted">
            <strong>—</strong>
            <Sparkline values={[]} />
            <span>Kopplas till Stripe</span>
          </div>
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
function List({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: { id: string; name: string; since: string }[];
}) {
  return (
    <section className="panel pt-card">
      <h2>
        {title}
        <span className="pt-count">{rows.length}</span>
      </h2>
      {rows.length ? (
        <ul className="dashboard-events">
          {rows.map((r) => (
            <li key={r.id}>
              <span>{r.name}</span>
              <time>{date(r.since)}</time>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pt-muted">{empty}</p>
      )}
    </section>
  );
}
function Sparkline({ values }: { values: number[] }) {
  const w = 240,
    h = 56,
    max = Math.max(1, ...values),
    pts = values.length > 1 ? values : [0, 0];
  const d = pts
    .map(
      (v, i) =>
        (i ? "L" : "M") +
        (i / (pts.length - 1)) * w +
        " " +
        (h - 4 - (v / max) * (h - 8)),
    )
    .join(" ");
  return (
    <svg
      className={"pt-spark" + (values.length > 1 ? "" : " is-empty")}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

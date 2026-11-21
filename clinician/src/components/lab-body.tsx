"use client";
import { useMemo, useState } from "react";
import { catalog, displayStatus, type ClinicalRecord, type Observation } from "@/lib/model";
import "./lab-body.css";

type Organ = "thyroid" | "lungs" | "heart" | "liver" | "kidneys" | "other";

const organs: { id: Organ; title: string; color: string; x: number; y: number; glyph: string[] }[] = [
  { id: "thyroid", title: "Sköldkörtelfunktion", color: "#7a4fb5", x: 0, y: 0.178,
    glyph: ["M12 9C10 7 6 7 5 10C4 13 7 16 10 15L11 12Q12 11 13 12L14 15C17 16 20 13 19 10C18 7 14 7 12 9Z"] },
  { id: "lungs", title: "Lungor", color: "#2f8f86", x: -0.083, y: 0.275,
    glyph: ["M10 5C7 6 3 12 3 17C3 20 5 20 7 20C9 20 10 19 10 17Z", "M14 5C17 6 21 12 21 17C21 20 19 20 17 20C15 20 14 19 14 17Z", "M12 3V11M12 11L10 13M12 11L14 13"] },
  { id: "heart", title: "Hjärta och blodfetter", color: "#bb3278", x: 0.052, y: 0.292,
    glyph: ["M9 8C3 7 2 12 4 16C7 21 15 23 18 22C22 21 23 18 21 14C20 11 18 9 15 8L15 5Q16 4 18 4L18 2Q12 1 11 5L11 7Q9 5 8 3L6 4Z", "M9 8Q13 9 15 13Q16 15 17 19M13 11Q12 14 9 15"] },
  { id: "liver", title: "Leverfunktion", color: "#94591f", x: -0.059, y: 0.401,
    glyph: ["M2 9C2 6 5 5 9 5C14 5 19 7 22 7Q24 7 22 10Q20 12 15 14C10 16 8 20 4 20Q2 20 2 17Z", "M12 5.5Q13.5 10 12 15.5"] },
  { id: "kidneys", title: "Njurfunktion", color: "#4a62b8", x: 0.058, y: 0.462,
    glyph: ["M8 4C5 4 3 7 3 11C3 15 5 19 8 19C10 19 10 17 9 15C8 13 8 12 9 11C10 10 10 8 9 6C8 4 8 4 8 4Z", "M16 4C19 4 21 7 21 11C21 15 19 19 16 19C14 19 14 17 15 15C16 13 16 12 15 11C14 10 14 8 15 6C16 4 16 4 16 4Z"] },
];
const otherOrgan = { id: "other" as Organ, title: "Övriga blodvärden", color: "#6b6577" };

type Reading = { code: string; name: string; unit: string; points: { at: string; value: number }[]; latest: Observation; latestAt: string };

function sexFromIdentity(label: string): "male" | "female" {
  const digits = label.replace(/\D/g, "");
  const digit = digits.length === 12 ? digits[10] : digits.length === 10 ? digits[8] : undefined;
  return digit !== undefined && Number(digit) % 2 === 0 ? "female" : "male";
}
const when = (iso: string) =>
  new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });

function Glyph({ paths, color }: { paths: string[]; color: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

function Spark({ points }: { points: { at: string; value: number }[] }) {
  if (points.length < 2) return <span className="lb-nohist">En mätning</span>;
  const w = 88;
  const h = 30;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (w - 6) + 3, h - 4 - ((p.value - min) / span) * (h - 8)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg className="lb-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-label="Historik">
      <path d={`${line} L${xy[xy.length - 1][0]} ${h} L${xy[0][0]} ${h} Z`} fill="#bb327815" />
      <path d={line} fill="none" stroke="#bb3278" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      {xy.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === xy.length - 1 ? 2.6 : 1.6} fill="#bb3278" />
      ))}
    </svg>
  );
}

export function LabBody({ records, identity }: { records: ClinicalRecord[]; identity: string }) {
  const readings = useMemo(() => {
    const byCode = new Map<string, Reading>();
    const published = records.filter((r) => r.kind === "lab" && r.status === "published" && !r.superseded_at);
    for (const record of [...published].sort((a, b) => a.payload.sampledAt.localeCompare(b.payload.sampledAt))) {
      for (const o of record.payload.observations ?? []) {
        const meta = catalog.find((c) => c.code === o.code);
        const value = Number(o.value);
        const existing = byCode.get(o.code);
        const reading: Reading = existing ?? { code: o.code, name: meta?.name ?? o.name, unit: o.unit, points: [], latest: o, latestAt: record.payload.sampledAt };
        if (Number.isFinite(value)) reading.points.push({ at: record.payload.sampledAt, value });
        reading.latest = o;
        reading.latestAt = record.payload.sampledAt;
        reading.unit = o.unit || reading.unit;
        byCode.set(o.code, reading);
      }
    }
    return byCode;
  }, [records]);

  const forOrgan = (id: Organ) =>
    catalog.filter((c) => c.organ === id).map((c) => readings.get(c.code)).filter((r): r is Reading => !!r);
  const outside = (id: Organ) => forOrgan(id).filter((r) => displayStatus(r.latest) === "Utanför intervall").length;

  const initial =
    organs.map((o) => o.id).sort((a, b) => outside(b) - outside(a)).find((id) => forOrgan(id).length) ?? "thyroid";
  const [selected, setSelected] = useState<Organ>(initial);
  const sex = sexFromIdentity(identity);
  const current = selected === "other" ? otherOrgan : organs.find((o) => o.id === selected)!;
  const list = forOrgan(selected);
  const hasOther = forOrgan("other").length > 0;
  const flagged = list.filter((r) => displayStatus(r.latest) === "Utanför intervall").length;

  return (
    <div className="lb">
      <div className="lb-figure" aria-label="Kroppsöversikt">
        <div className="lb-stage">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/body-${sex}.jpg`} alt="" draggable={false} />
          {organs.map((o) => {
            const count = forOrgan(o.id).length;
            const out = outside(o.id);
            return (
              <button
                key={o.id}
                className={"lb-marker" + (selected === o.id ? " is-selected" : "") + (count ? "" : " is-empty")}
                style={{ left: `${50 + (o.x / 0.75) * 100}%`, top: `${o.y * 100}%`, ["--c" as string]: o.color }}
                aria-label={`${o.title}${count ? `, ${count} markörer${out ? `, ${out} utanför intervall` : ""}` : ", inga prover"}`}
                aria-pressed={selected === o.id}
                onClick={() => setSelected(o.id)}
              >
                <span className="lb-glyph">
                  <Glyph paths={o.glyph} color={o.color} />
                </span>
                {out > 0 && <i className="lb-flag">{out}</i>}
              </button>
            );
          })}
        </div>
        {hasOther && (
          <button className={"lb-other" + (selected === "other" ? " is-selected" : "")} onClick={() => setSelected("other")}>
            Övriga blodvärden
            {outside("other") > 0 && <i className="lb-flag">{outside("other")}</i>}
          </button>
        )}
      </div>
      <section className="lb-panel" aria-live="polite">
        <header>
          <div>
            <h3>{current.title}</h3>
            <p>{list.length ? `Publicerade provsvar · senast ${when(list.map((r) => r.latestAt).sort().at(-1)!)}` : "Inga publicerade provsvar"}</p>
          </div>
          {list.length > 0 && (
            <span className={"lb-summary " + (flagged ? "warn" : "ok")}>{flagged ? `${flagged} utanför intervall` : "Alla inom intervall"}</span>
          )}
        </header>
        {list.length ? (
          <table>
            <thead>
              <tr>
                <th>Markör</th>
                <th>Status</th>
                <th>Värde</th>
                <th>Historik</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const status = displayStatus(r.latest);
                const reference = r.latest.referenceText || (r.latest.referenceLow !== null || r.latest.referenceHigh !== null ? `${r.latest.referenceLow ?? "—"} – ${r.latest.referenceHigh ?? "—"}` : "");
                return (
                  <tr key={r.code}>
                    <td>
                      <strong>{r.name}</strong>
                      <small>Senast tagen {when(r.latestAt)}</small>
                    </td>
                    <td>
                      <span className={"lb-status " + (status === "Utanför intervall" ? "warn" : status === "Inom intervall" ? "ok" : "")}>{status}</span>
                    </td>
                    <td>
                      <strong>
                        {r.latest.comparator === "=" || r.latest.comparator === "text" ? "" : r.latest.comparator}
                        {r.latest.value} <small>{r.unit}</small>
                      </strong>
                      {reference && <small>Ref. {reference}</small>}
                    </td>
                    <td>
                      <Spark points={r.points} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="lb-empty">Inga markörer för {current.title.toLowerCase()} är publicerade ännu.</p>
        )}
      </section>
    </div>
  );
}

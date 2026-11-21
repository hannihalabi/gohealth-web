"use client";
import { Activity, ArrowRight, CheckCircle2, FlaskConical, ImageIcon, Syringe } from "lucide-react";
import type { Kind } from "@/lib/model";

export type PendingItem = {
  id: string;
  patient_id: string;
  display_name: string;
  identity_label: string;
  identity_verified: boolean;
  kind: Kind;
  version: number;
  revision: number;
  is_correction: boolean;
  created_at: string;
  created_by_name: string | null;
  payload: { title?: string; sampledAt?: string; modality?: string; bodyPart?: string; vaccine?: string };
};

const kinds = {
  lab: { label: "Blodprov", Icon: FlaskConical },
  vaccination: { label: "Vaccination", Icon: Syringe },
  imaging: { label: "Bilddiagnostik", Icon: ImageIcon },
} as const;
const when = (iso: string) => new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });

export function AttestationGrid({
  items,
  loading,
  error,
  isDoctor,
  onReview,
  onRefresh,
}: {
  items: PendingItem[] | null;
  loading: boolean;
  error: string;
  isDoctor: boolean;
  onReview: (item: PendingItem) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="grid-view">
      <div className="grid-toolbar">
        <span className="grid-title">
          <Activity size={16} /> Inväntar granskning och publicering
        </span>
        <span className="grid-spacer" />
        <button className="grid-btn" type="button" aria-label="Uppdatera" disabled={loading} onClick={onRefresh}>
          ↻
        </button>
      </div>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <div className="grid-scroll">
        {items && items.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>Typ <i>kategori</i></th>
                <th>Uppgift <i>text</i></th>
                <th>Patient <i>text</i></th>
                <th>Skapad av <i>text</i></th>
                <th>Skapad <i>tid</i></th>
                <th>Status <i>status</i></th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const { label, Icon } = kinds[item.kind];
                return (
                  <tr key={item.id} onClick={() => onReview(item)}>
                    <td>
                      <span className="grid-kind">
                        <Icon size={15} /> {label}
                      </span>
                    </td>
                    <td>
                      <strong>{item.payload.title ?? label}</strong>
                      {item.kind === "imaging" && item.payload.modality && (
                        <small className="grid-sub">
                          {item.payload.modality} · {item.payload.bodyPart}
                        </small>
                      )}
                      {item.kind === "vaccination" && item.payload.vaccine && (
                        <small className="grid-sub">{item.payload.vaccine}</small>
                      )}
                    </td>
                    <td>
                      {item.display_name}
                      <small className="grid-sub">{item.identity_label}</small>
                    </td>
                    <td>{item.created_by_name ?? "—"}</td>
                    <td>{when(item.created_at)}</td>
                    <td>
                      <span className={"grid-chip " + (item.identity_verified ? "warn" : "bad")}>
                        {!item.identity_verified
                          ? "Identitet ej verifierad"
                          : item.is_correction
                            ? "Rättelse väntar"
                            : "Väntar på granskning"}
                      </span>
                    </td>
                    <td className="grid-open">
                      <button className="button primary small" onClick={(e) => { e.stopPropagation(); onReview(item); }}>
                        {isDoctor ? "Granska" : "Öppna"} <ArrowRight size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {items && !items.length && !error && (
          <div className="grid-clear">
            <CheckCircle2 size={30} />
            <strong>Allt är attesterat</strong>
            <span>Inga uppgifter väntar på granskning.</span>
          </div>
        )}
        {!items && !error && <p className="grid-clear" role="status">Hämtar…</p>}
      </div>
      <div className="grid-footer">
        <span>{isDoctor ? "Läkare granskar och publicerar" : "Endast läkare kan publicera"}</span>
        <span>{items?.length ?? 0} {items?.length === 1 ? "uppgift" : "uppgifter"}</span>
      </div>
    </div>
  );
}

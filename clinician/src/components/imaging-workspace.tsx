"use client";
import { useMemo, useState, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import type { ClinicalRecord, Payload } from "@/lib/model";
import { StudyViewer } from "./study-viewer";
import "./imaging-workspace.css";

const modalities: { id: NonNullable<Payload["modality"]>; label: string }[] = [
  { id: "MR", label: "MR" },
  { id: "CT", label: "DT" },
  { id: "XR", label: "Röntgen" },
  { id: "US", label: "Ultraljud" },
  { id: "OTHER", label: "Övrigt" },
];
const dateOf = (value: string) =>
  new Date(value).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });

export function ImagingWorkspace({
  records,
  demo,
  canRemove,
  renderReport,
  onChanged,
}: {
  records: ClinicalRecord[];
  demo: boolean;
  canRemove: (record: ClinicalRecord) => boolean;
  renderReport: (record: ClinicalRecord) => ReactNode;
  onChanged: () => void;
}) {
  const imaging = useMemo(
    () => records.filter((r) => r.kind === "imaging").sort((a, b) => b.payload.sampledAt.localeCompare(a.payload.sampledAt)),
    [records],
  );
  const count = (id: string) => imaging.filter((r) => (r.payload.modality ?? "OTHER") === id).length;
  const [modality, setModality] = useState(() => (count("MR") ? "MR" : modalities.find((m) => count(m.id))?.id ?? "MR"));
  const [selected, setSelected] = useState<string>();
  const studies = imaging.filter((r) => (r.payload.modality ?? "OTHER") === modality);
  const study = studies.find((r) => r.id === selected) ?? studies[0];

  return (
    <div className="iw">
      <div className="iw-tabs" role="tablist" aria-label="Undersökningstyp">
        {modalities.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={modality === m.id}
            className={modality === m.id ? "active" : ""}
            onClick={() => {
              setModality(m.id);
              setSelected(undefined);
            }}
          >
            {m.label}
            <small>{count(m.id)}</small>
          </button>
        ))}
      </div>
      {studies.length > 1 && (
        <div className="iw-studies" aria-label="Undersökningar">
          {studies.map((r) => (
            <button key={r.id} className={r.id === study?.id ? "active" : ""} onClick={() => setSelected(r.id)}>
              <strong>{r.payload.title}</strong>
              <small>
                {dateOf(r.payload.sampledAt)} · {r.payload.bodyPart}
              </small>
            </button>
          ))}
        </div>
      )}
      {study ? (
        <div className="iw-study" key={study.id}>
          <div className="iw-viewer">
            {study.payload.archiveId ? (
              <StudyViewer
                recordId={study.id}
                title={study.payload.title}
                demo={demo}
                autoLoad
                canRemove={canRemove(study)}
                onRemoved={onChanged}
              />
            ) : (
              <div className="iw-none">
                <ImageIcon size={30} />
                <strong>Inga bilder bifogade</strong>
                <span>Skapa en rättelse och bifoga en ZIP-fil för att visa bilderna här.</span>
              </div>
            )}
          </div>
          <div className="iw-report">{renderReport(study)}</div>
        </div>
      ) : (
        <div className="iw-none">
          <ImageIcon size={30} />
          <strong>Inga undersökningar</strong>
          <span>Registrera ett utlåtande för att lägga till bilder.</span>
        </div>
      )}
    </div>
  );
}

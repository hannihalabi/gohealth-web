"use client";
import { Download, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ctArchiveRequest } from "@/lib/ct-archive-upload";
import { demoSeries, loadSeries, type Series, type Slice } from "@/lib/image-stack";
import "./study-viewer.css";

type State =
  | { phase: "idle" }
  | { phase: "loading"; label: string }
  | { phase: "ready"; series: Series[] }
  | { phase: "removed"; reason?: string; at?: string }
  | { phase: "error"; message: string };

export function StudyViewer({
  recordId,
  title,
  demo,
  autoLoad,
  canRemove,
  onRemoved,
}: {
  recordId: string;
  title: string;
  demo: boolean;
  autoLoad: boolean;
  canRemove: boolean;
  onRemoved: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const [seriesIndex, setSeriesIndex] = useState(0);
  const [index, setIndex] = useState(0);
  const [level, setLevel] = useState({ center: 0, width: 1 });
  const [invert, setInvert] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; center: number; width: number } | null>(null);

  const load = useCallback(async () => {
    setState({ phase: "loading", label: "Hämtar bilder…" });
    try {
      if (demo) {
        setState({ phase: "ready", series: demoSeries() });
        return;
      }
      const link = await ctArchiveRequest<{ url?: string; removed?: boolean; reason?: string; removedAt?: string }>({
        action: "download",
        recordId,
        inline: true,
      });
      if (link.removed || !link.url) {
        setState({ phase: "removed", reason: link.reason, at: link.removedAt });
        return;
      }
      const response = await fetch(link.url, { cache: "no-store" });
      if (!response.ok) throw new Error("Bilderna kunde inte hämtas. Försök igen.");
      const buffer = await response.arrayBuffer();
      const { series } = await loadSeries(buffer, (done, total) =>
        setState({ phase: "loading", label: `Läser in bilder ${done} / ${total}` }),
      );
      setState({ phase: "ready", series });
    } catch (e) {
      setState({ phase: "error", message: e instanceof Error ? e.message : "Bilderna kunde inte visas." });
    }
  }, [demo, recordId]);

  useEffect(() => {
    if (autoLoad && state.phase === "idle") void load();
  }, [autoLoad, load, state.phase]);

  const series = state.phase === "ready" ? state.series[seriesIndex] : undefined;
  const slice: Slice | undefined = series?.slices[Math.min(index, (series?.slices.length ?? 1) - 1)];

  const resetLevel = useCallback(() => {
    if (slice?.kind === "gray") {
      setLevel({ center: slice.center, width: slice.windowWidth });
      setInvert(false);
    }
  }, [slice]);
  useEffect(() => {
    // Open in the middle of the stack, where the anatomy is usually found.
    setIndex(Math.floor((series?.slices.length ?? 0) / 2));
  }, [series]);
  useEffect(() => {
    if (series?.slices[0]?.kind === "gray") {
      const first = series.slices[0];
      setLevel({ center: first.center, width: first.windowWidth });
      setInvert(false);
    }
  }, [series]);

  useEffect(() => {
    const target = canvas.current;
    if (!target || !slice) return;
    target.width = slice.width;
    target.height = slice.height;
    const context = target.getContext("2d");
    if (!context) return;
    if (slice.kind === "bitmap") {
      context.drawImage(slice.bitmap, 0, 0);
      return;
    }
    const image = context.createImageData(slice.width, slice.height);
    const low = level.center - level.width / 2;
    const scale = 255 / Math.max(level.width, 1e-6);
    const flip = invert !== slice.invert;
    const data = image.data;
    for (let i = 0; i < slice.values.length; i++) {
      let v = (slice.values[i] - low) * scale;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (flip) v = 255 - v;
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [slice, level, invert]);

  useEffect(() => {
    if (!playing || !series) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % series.slices.length), 90);
    return () => clearInterval(timer);
  }, [playing, series]);

  function step(delta: number) {
    if (!series) return;
    setIndex((i) => Math.min(series.slices.length - 1, Math.max(0, i + delta)));
  }
  async function download() {
    setBusy(true);
    try {
      const { url } = await ctArchiveRequest<{ url: string }>({ action: "download", recordId });
      const link = document.createElement("a");
      link.href = url;
      link.download = "bilder.zip";
      link.click();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ZIP-filen kunde inte hämtas.");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await ctArchiveRequest({ action: "remove", recordId, reason });
      setConfirming(false);
      setReason("");
      onRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bilderna kunde inte tas bort.");
    } finally {
      setBusy(false);
    }
  }

  if (state.phase === "removed")
    return (
      <div className="sv sv-empty">
        <Trash2 size={28} />
        <strong>Bilderna är borttagna</strong>
        {state.reason && <span>Orsak: {state.reason}</span>}
      </div>
    );
  if (state.phase === "idle")
    return (
      <div className="sv sv-empty">
        <button className="button primary" onClick={() => void load()}>
          Visa bilder
        </button>
      </div>
    );
  if (state.phase === "loading")
    return (
      <div className="sv sv-empty" role="status">
        <progress aria-label="Läser in bilder" />
        <span>{state.label}</span>
      </div>
    );
  if (state.phase === "error")
    return (
      <div className="sv sv-empty">
        <span role="alert">{state.message}</span>
        <div className="sv-row">
          <button className="button secondary small" onClick={() => void load()}>
            Försök igen
          </button>
          {!demo && (
            <button className="button secondary small" onClick={() => void download()} disabled={busy}>
              <Download size={15} /> Hämta ZIP
            </button>
          )}
        </div>
      </div>
    );

  const count = series?.slices.length ?? 0;
  return (
    <div className="sv">
      <div
        className="sv-stage"
        tabIndex={0}
        aria-label={`Bildvisare, ${title}`}
        onWheel={(e) => {
          e.preventDefault();
          step(e.deltaY > 0 ? 1 : -1);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "PageDown") step(1);
          if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp") step(-1);
          if (e.key === " ") {
            e.preventDefault();
            setPlaying((p) => !p);
          }
        }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, center: level.center, width: level.width };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || slice?.kind !== "gray") return;
          const range = slice.windowWidth || 1;
          setLevel({
            width: Math.max(1, d.width + ((e.clientX - d.x) / 300) * range),
            center: d.center + ((e.clientY - d.y) / 300) * range,
          });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <canvas ref={canvas} />
        <span className="sv-tl">{series?.title}</span>
        <span className="sv-tr">
          Bild {Math.min(index, count - 1) + 1} / {count}
        </span>
        {slice?.kind === "gray" && (
          <span className="sv-bl">
            C {Math.round(level.center)} · W {Math.round(level.width)}
          </span>
        )}
      </div>
      <div className="sv-controls">
        <button aria-label={playing ? "Pausa" : "Spela upp"} onClick={() => setPlaying((p) => !p)}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <input
          type="range"
          aria-label="Bildposition"
          min={0}
          max={Math.max(0, count - 1)}
          value={Math.min(index, count - 1)}
          onChange={(e) => setIndex(Number(e.target.value))}
        />
        {slice?.kind === "gray" && (
          <>
            <button onClick={() => setInvert((v) => !v)}>Invertera</button>
            <button aria-label="Återställ fönster" onClick={resetLevel}>
              <RotateCcw size={15} />
            </button>
          </>
        )}
      </div>
      {state.phase === "ready" && state.series.length > 1 && (
        <div className="sv-series" role="tablist" aria-label="Serier">
          {state.series.map((s, i) => (
            <button key={s.id} role="tab" aria-selected={i === seriesIndex} className={i === seriesIndex ? "active" : ""} onClick={() => setSeriesIndex(i)}>
              {s.title} <small>{s.slices.length}</small>
            </button>
          ))}
        </div>
      )}
      {!demo && (
        <div className="sv-actions">
          <button className="button secondary small" onClick={() => void download()} disabled={busy}>
            <Download size={15} /> Hämta ZIP
          </button>
          {canRemove && !confirming && (
            <button className="button secondary small sv-danger" onClick={() => setConfirming(true)}>
              <Trash2 size={15} /> Ta bort bilder
            </button>
          )}
        </div>
      )}
      {confirming && (
        <div className="sv-confirm">
          <label>
            Orsak till att bilderna tas bort
            <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Till exempel: fel patient" />
          </label>
          <p>Bilderna raderas och patienten kan inte längre öppna dem. Utlåtandet ligger kvar. Åtgärden loggas.</p>
          <div className="sv-row">
            <button className="button primary small sv-danger-fill" disabled={busy || !reason.trim()} onClick={() => void remove()}>
              Ta bort bilder
            </button>
            <button className="button secondary small" disabled={busy} onClick={() => setConfirming(false)}>
              Avbryt
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

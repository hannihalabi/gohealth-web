"use client";
import { CalendarPlus, ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { addDays, clock, dayLabel, slotCount, stockholmDate, timeRange, visitTypes, weekDays, weekStart, type VisitType } from "@/lib/booking";
import { isoWeek } from "@/lib/vitals-trend";
import "./calendar-view.css";

type Time = {
  id: string;
  starts_at: string;
  ends_at: string;
  booking: { id: string; patient_id: string; patient: string; visit_type: VisitType } | null;
};
type Upcoming = { id: string; patient_id: string; patient: string; visit_type: VisitType; starts_at: string; ends_at: string };
type Calendar = { times: Time[]; upcoming: Upcoming[] };

async function post(body: unknown) {
  const r = await fetch("/api/clinical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Kalendern kunde inte hämtas.");
  return data;
}
/** Stockholm wall-clock time on a date, as an instant. Good enough for the demonstration calendar. */
function at(date: string, time: string) {
  const guess = new Date(`${date}T${time}:00Z`);
  const shown = guess.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
  const [h, m] = shown.split(":").map(Number);
  const [wh, wm] = time.split(":").map(Number);
  return new Date(guess.getTime() - ((h * 60 + m) - (wh * 60 + wm)) * 60000);
}
function demoCalendar(): Calendar {
  const start = weekStart(stockholmDate());
  const times: Time[] = [];
  for (const d of [1, 3]) {
    const day = addDays(start, d);
    for (let i = 0; i < 6; i++) {
      const s = at(day, `${String(9 + Math.floor(i / 3)).padStart(2, "0")}:${String((i % 3) * 20).padStart(2, "0")}`);
      times.push({ id: `demo-${d}-${i}`, starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 20 * 60000).toISOString(),
        booking: i === 1 && d === 3 ? { id: "demo-b1", patient_id: "00000000-0000-4000-8000-000000000001", patient: "Alex Lind", visit_type: "video" } : null });
    }
  }
  const booked = times.find((t) => t.booking)!;
  return { times, upcoming: [{ id: "demo-b1", patient_id: booked.booking!.patient_id, patient: "Alex Lind", visit_type: "video", starts_at: booked.starts_at, ends_at: booked.ends_at }] };
}

/** "Kalender": the clinician's own free times, which patients book from the chat, and the bookings. */
export function CalendarView({ demo, onOpenPatient }: { demo: boolean; onOpenPatient: (p: { id: string; display_name: string }) => void }) {
  const today = stockholmDate();
  const [week, setWeek] = useState(weekStart(today));
  const [data, setData] = useState<Calendar | null>(demo ? demoCalendar() : null);
  const [date, setDate] = useState(addDays(today, 1));
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("12:00");
  const [minutes, setMinutes] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (demo) return;
    setBusy(true);
    try {
      setData(await post({ action: "calendar", op: "list", from: week, days: 7 }));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [demo, week]);
  useEffect(() => { void load(); }, [load]);

  const days = weekDays(week);
  const byDay = useMemo(() => {
    const map = new Map<string, Time[]>();
    for (const t of data?.times ?? []) {
      const d = stockholmDate(new Date(t.starts_at));
      map.set(d, [...(map.get(d) ?? []), t]);
    }
    return map;
  }, [data]);
  const count = slotCount(from, to, minutes);
  const free = (data?.times ?? []).filter((t) => !t.booking && Date.parse(t.starts_at) > Date.now()).length;

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (demo) {
        const extra: Time[] = Array.from({ length: count }, (_, i) => {
          const s = new Date(at(date, from).getTime() + i * minutes * 60000);
          return { id: crypto.randomUUID(), starts_at: s.toISOString(), ends_at: new Date(s.getTime() + minutes * 60000).toISOString(), booking: null };
        });
        setData((d) => d && { ...d, times: [...d.times, ...extra].sort((a, b) => a.starts_at.localeCompare(b.starts_at)) });
        setNotice(`${count} tider tillagda.`);
      } else {
        const r = await post({ action: "calendar", op: "add", date, start: from, end: to, minutes });
        setNotice(r.added === count ? `${r.added} tider tillagda.` : `${r.added} tider tillagda. ${count - r.added} krockade med tider du redan har.`);
        await load();
      }
      setWeek(weekStart(date));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(t: Time) {
    setBusy(true);
    setError("");
    try {
      if (demo) setData((d) => d && { ...d, times: d.times.filter((x) => x.id !== t.id) });
      else {
        await post({ action: "calendar", op: "remove", slotId: t.id });
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const { week: weekNo } = isoWeek(week);
  return (
    <section className="cal" aria-label="Kalender">
      <header className="cal-head">
        <div>
          <h1>Kalender</h1>
          <p>Dina lediga tider. Patienter bokar dem när du skickar Boka tid i chatten.</p>
        </div>
        {!demo && (
          <button className="button secondary" disabled={busy} onClick={() => void load()}><RefreshCw size={15} /> Uppdatera</button>
        )}
      </header>

      <form className="panel cal-add" onSubmit={add}>
        <h2><CalendarPlus size={17} /> Lägg in lediga tider</h2>
        <div className="cal-fields">
          <label>Datum<input type="date" required min={today} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Från<input type="time" required step={300} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Till<input type="time" required step={300} value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label>Längd per tid
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {[10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
          <button className="button primary" disabled={busy || count < 1 || count > 96}>
            {count > 0 ? `Lägg till ${count} ${count === 1 ? "tid" : "tider"}` : "Lägg till"}
          </button>
        </div>
        {notice && <p className="cal-notice" role="status">{notice}</p>}
      </form>
      {error && <div className="alert error" role="alert">{error}</div>}

      <div className="cal-layout">
        <div className="panel cal-week">
          <div className="cal-nav">
            <button className="grid-btn" aria-label="Föregående vecka" onClick={() => setWeek(addDays(week, -7))}><ChevronLeft size={16} /></button>
            <strong>Vecka {weekNo}</strong>
            <span>{dayLabel(days[0]).slice(4)} – {dayLabel(days[6]).slice(4)}</span>
            <button className="grid-btn" aria-label="Nästa vecka" onClick={() => setWeek(addDays(week, 7))}><ChevronRight size={16} /></button>
            {week !== weekStart(today) && <button className="link-button" onClick={() => setWeek(weekStart(today))}>Idag</button>}
            <small>{free} lediga tider denna vecka</small>
          </div>
          <div className="cal-grid">
            {days.map((d) => (
              <div key={d} className={"cal-day" + (d === today ? " is-today" : "") + (d < today ? " is-past" : "")}>
                <button className="cal-day-head" disabled={d < today} title="Lägg in tider denna dag" onClick={() => setDate(d)}>
                  {dayLabel(d).replace(/^./, (c) => c.toUpperCase())}
                </button>
                <div className="cal-times">
                  {(byDay.get(d) ?? []).map((t) => (
                    t.booking ? (
                      <button key={t.id} className="cal-time is-booked" onClick={() => onOpenPatient({ id: t.booking!.patient_id, display_name: t.booking!.patient })}
                        title={`${t.booking.patient} · ${visitTypes[t.booking.visit_type]}`}>
                        <b>{clock(t.starts_at)}</b>
                        <span>{t.booking.patient}</span>
                        <small>{visitTypes[t.booking.visit_type]}</small>
                      </button>
                    ) : (
                      <span key={t.id} className={"cal-time is-free" + (Date.parse(t.starts_at) < Date.now() ? " is-past" : "")}>
                        <b>{clock(t.starts_at)}–{clock(t.ends_at)}</b>
                        <button aria-label={`Ta bort ${clock(t.starts_at)}`} disabled={busy} onClick={() => void remove(t)}><X size={12} /></button>
                      </span>
                    )
                  ))}
                  {!(byDay.get(d) ?? []).length && <span className="cal-none">–</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
        <aside className="panel cal-upcoming">
          <h2>Kommande bokningar</h2>
          {!data ? <p className="cal-none">Hämtar…</p> : !data.upcoming.length ? (
            <p className="cal-none">Inga bokningar ännu.</p>
          ) : (
            <ul>
              {data.upcoming.map((b) => (
                <li key={b.id}>
                  <button onClick={() => onOpenPatient({ id: b.patient_id, display_name: b.patient })}>
                    <strong>{b.patient}</strong>
                    <span>{timeRange(b.starts_at, b.ends_at)}</span>
                    <small>{visitTypes[b.visit_type]}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </section>
  );
}

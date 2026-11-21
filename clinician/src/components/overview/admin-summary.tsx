"use client";
import { Globe, Smartphone, UserCheck, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { invitationState, type AdministrationData, type Member } from "@/lib/administration";
import { groupCareTeams, readOrganizationDirectory } from "@/lib/organization-directory";
import type { PipelineData } from "@/lib/pipeline";

type Counts = { members: Member[]; pending: number; signups: number; applications: number };

async function loadPipeline(organizationId: string, signal: AbortSignal): Promise<PipelineData> {
  const response = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pipeline", organizationId }),
    cache: "no-store",
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || "Väntande uppgifter kunde inte hämtas.");
  return data;
}

function Ring({ value, total }: { value: number; total: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const share = total ? value / total : 0;
  return (
    <svg className="as-ring" viewBox="0 0 88 88" width="88" height="88" role="img" aria-label={`${value} av ${total} patienter har en behandlare`}>
      <circle cx="44" cy="44" r={r} fill="none" stroke="#f1edf3" strokeWidth="10" />
      <circle cx="44" cy="44" r={r} fill="none" stroke={share === 1 ? "#2fa57a" : "var(--plum)"} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${share * c} ${c}`} transform="rotate(-90 44 44)" />
      <text x="44" y="49" textAnchor="middle" fontSize="18" fontWeight="700" fill="currentColor">{total ? Math.round(share * 100) : 0}%</text>
    </svg>
  );
}

export function AdminSummary({ organizationId, demo, administration }: { organizationId: string; demo: boolean; administration: AdministrationData | null }) {
  const [live, setLive] = useState<Counts | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    let disposed = false;
    async function read() {
      try {
        const [directory, pipeline] = await Promise.all([
          readOrganizationDirectory(organizationId, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])),
          loadPipeline(organizationId, controller.signal),
        ]);
        if (!disposed) {
          setLive({ members: directory.members, pending: directory.pending, signups: pipeline.signupTotal, applications: pipeline.applicationTotal });
          setError("");
        }
      } catch (e) {
        if (!disposed && !controller.signal.aborted) setError(e instanceof Error ? e.message : "Sammanfattningen kunde inte hämtas.");
      }
    }
    void read();
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 30000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [organizationId, demo]);

  const counts: Counts | null = useMemo(() => {
    if (!demo) return live;
    if (!administration) return null;
    return {
      members: administration.members.map((m) => ({ ...m, doctor_id: m.doctor_id ?? null })),
      pending: administration.invitations.filter((i) => invitationState(i) === "Väntar på aktivering").length,
      signups: 0,
      applications: 0,
    };
  }, [demo, live, administration]);

  const patients = useMemo(() => {
    const active = (administration?.patients ?? []).filter((p) => p.active);
    const assigned = new Set((administration?.assignments ?? []).filter((a) => a.active).map((a) => a.patient_id));
    return { total: active.length, assigned: active.filter((p) => assigned.has(p.id)).length };
  }, [administration]);

  if (!counts)
    return error ? <p className="alert error" role="alert">{error}</p> : <p className="overview-empty" role="status">Hämtar sammanfattning…</p>;

  const { teams, unassigned } = groupCareTeams(counts.members);
  const activeTeams = teams.filter((t) => t.doctor.active);
  const nurses = counts.members.filter((m) => m.role === "nurse" && m.active);
  const nursesInTeams = activeTeams.reduce((sum, t) => sum + t.nurses.length, 0);
  const waiting = patients.total - patients.assigned;

  return (
    <div className="as">
      {error && <p className="alert error" role="alert">{error}</p>}
      <div className="as-tiles">
        <div className={counts.signups ? "is-alert" : ""}><Smartphone size={15} /><strong>{counts.signups}</strong><span>Väntande onboarding</span></div>
        <div className={counts.applications ? "is-alert" : ""}><Globe size={15} /><strong>{counts.applications}</strong><span>Nya ansökningar</span></div>
        <div className={counts.pending ? "is-alert" : ""}><UserPlus size={15} /><strong>{counts.pending}</strong><span>Väntar på aktivering</span></div>
      </div>
      <section className="as-card">
        <h3>Patienter tilldelade</h3>
        <div className="as-ringrow">
          <Ring value={patients.assigned} total={patients.total} />
          <div>
            <strong>{patients.assigned} av {patients.total}</strong>
            <span className={waiting ? "as-warn" : "as-ok"}>{waiting ? `${waiting} utan behandlare` : "Alla har en behandlare"}</span>
          </div>
        </div>
      </section>
      <section className="as-card">
        <h3>
          Vårdteam
          <span className={nurses.length - nursesInTeams ? "as-warn" : "as-ok"}>
            {nurses.length ? `${nursesInTeams} av ${nurses.length} sjuksköterskor tilldelade` : "Inga sjuksköterskor"}
          </span>
        </h3>
        {activeTeams.length ? (
          <ul className="as-teams">
            {activeTeams.map(({ doctor, nurses: teamNurses }) => (
              <li key={doctor.user_id}>
                <span className="as-doc"><UserCheck size={14} />{doctor.display_name}</span>
                <span className="as-chips">
                  <b>{teamNurses.length}</b> sjuksköt. · <b>{doctor.patient_count ?? 0}</b> patienter
                </span>
                {teamNurses.length > 0 && <small>{teamNurses.map((n) => n.display_name).join(", ")}</small>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="overview-empty">Inga läkare i teamen ännu.</p>
        )}
        {unassigned.filter((n) => n.active).length > 0 && (
          <p className="as-warn as-note">Utan läkare: {unassigned.filter((n) => n.active).map((n) => n.display_name).join(", ")}</p>
        )}
      </section>
    </div>
  );
}

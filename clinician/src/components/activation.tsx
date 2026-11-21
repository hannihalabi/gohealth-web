"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Heart, ShieldCheck } from "lucide-react";
import type { PortalLinks } from "@/lib/portal-origins";
import type { RecoveryAccount } from "@/lib/recovery";
import { PasswordRecovery } from "./password-recovery";
import {
  roleNames,
  type PendingAccess,
  type PortalSession,
} from "@/lib/administration";
async function request(body?: unknown, recovery = false) {
  const r = await fetch("/api/activation" + (recovery ? "?recovery=1" : ""), {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Åtgärden kunde inte slutföras.");
  return data;
}
type Status = { email: string; invitations: PendingAccess[] };
type Initial = Status | { recovery: RecoveryAccount } | null;
export function Activation({ links }: { links: PortalLinks }) {
  const [status, setStatus] = useState<Status | null>(null),
    [signup, setSignup] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false),
    [recovery, setRecovery] = useState<RecoveryAccount | null>(null);
  const initial = useRef<Promise<Initial> | null>(null);
  const isCallback = useRef(false);
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code"), flowId = params.get("sb_flow_id");
    const reset = params.get("reset");
    if (reset === "1" || reset === "change") setRecoveryMode(true);
    if (code) isCallback.current = true;
    if (code) history.replaceState(null, "", "/activate");
    initial.current ??= code ? request({ action: "callback", code, flowId: flowId || undefined })
      : reset === "1" ? Promise.resolve(null) : request(undefined, reset === "change");
    initial.current
      .then((value) => {
        if (!active || !value) return;
        if ("recovery" in value) {
          setRecovery(value.recovery); setRecoveryMode(true);
          history.replaceState(null, "", "/activate?reset=change");
        } else setStatus(value);
      })
      .catch((e) => {
        if (active && (isCallback.current || reset === "change")) {
          setError(e.message);
          if (reset === "change") { setRecoveryMode(false); history.replaceState(null, "", "/activate"); }
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await request({
        action: signup ? "signup" : "login",
        email,
        password,
      });
      setPassword("");
      if (signup) {
        setSignup(false);
        setNotice(
          "Om registreringen kan slutföras får du ett bekräftelsemejl. Öppna länken och återvänd sedan hit för att logga in och acceptera din behörighet.",
        );
      } else setStatus(value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function accept(id: string) {
    setBusy(true);
    setError("");
    try {
      const session: PortalSession = await request({ action: "accept", id });
      location.assign(session.admin ? links.administration : links.clinical);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  if (recoveryMode) return <PasswordRecovery account={recovery} loading={busy} links={links} />;
  return (
    <main className="activation-shell">
      <section className="activation-card">
        <a className="brand" href={links.administration}>
          <span className="brand-mark">
            <Heart />
          </span>
          <span>
            Go<span>Health</span>
            <i>.</i>
          </span>
        </a>
        <div className="auth-icon">
          <ShieldCheck />
        </div>
        <p className="eyebrow">PERSONLIG BEHÖRIGHET</p>
        <h1>
          Aktivera din åtkomst<span>.</span>
        </h1>
        <p>
          Din mottagning behöver först ha lagt till din e-postadress. Logga in
          för att visa och acceptera din behörighet.
        </p>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="alert success" role="status">
            {notice}
          </div>
        )}
        {status ? (
          <>
            <p>
              Inloggad som <strong>{status.email}</strong>
            </p>
            {status.invitations.length ? (
              status.invitations.map((invite) => (
                <article className="activation-invitation" key={invite.id}>
                  <h2>{invite.organization}</h2>
                  <p>
                    {invite.name} · {roleNames[invite.role]}
                  </p>
                  <p>
                    {invite.role === "admin"
                      ? "Administrerar personal och tilldelningar. Rollen ger inte klinisk läsbehörighet."
                      : "Klinisk åtkomst kräver dessutom en aktiv patienttilldelning."}
                  </p>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void accept(invite.id)}
                  >
                    Acceptera behörigheten <ArrowRight size={17} />
                  </button>
                </article>
              ))
            ) : (
              <div className="empty">
                <h2>Ingen väntande behörighet</h2>
                <p>
                  Kontrollera att administratören har angett samma e-postadress.
                  En återkallad eller utgången tilldelning behöver skapas på
                  nytt.
                </p>
                <a href={links.administration}>Till inloggningen</a>
              </div>
            )}
            <button
              className="text-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await request({ action: "logout" });
                  setStatus(null);
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Byt konto
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2>
              {signup
                ? "Registrera ett GoHealth-konto"
                : "Logga in med ditt GoHealth-konto"}
            </h2>
            <label>
              E-postadress
              <input
                required
                type="email"
                autoComplete="username"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Lösenord
              <input
                required
                type="password"
                autoComplete={signup ? "new-password" : "current-password"}
                minLength={signup ? 12 : 1}
                maxLength={200}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {signup && (
              <p className="muted">
                Använd minst 12 tecken. Kontot behöver verifieras via e-post
                innan någon personalbehörighet kan aktiveras.
              </p>
            )}
            <button className="button primary" disabled={busy}>
              {signup ? "Registrera konto" : "Logga in och visa behörigheter"}{" "}
              <ArrowRight size={17} />
            </button>
            <a href={links.activation + "?reset=1"}>Glömt lösenord?</a>
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setSignup(!signup);
                setError("");
                setPassword("");
              }}
            >
              {signup
                ? "Jag har redan ett konto"
                : "Jag behöver skapa ett konto"}
            </button>
          </form>
        )}
        <p className="auth-note">
          Registrering ger ingen personalbehörighet i sig. Endast en aktiv
          tilldelning från mottagningen kan accepteras.
        </p>
      </section>
    </main>
  );
}

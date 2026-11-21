"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Heart, LockKeyhole } from "lucide-react";
import type { PortalLinks } from "@/lib/portal-origins";
import type { RecoveryAccount } from "@/lib/recovery";
async function request(body: unknown) {
  const response = await fetch("/api/activation", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store",
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Återställningen kunde inte slutföras.");
  return value;
}
export function PasswordRecovery({ account: linkedAccount, loading, links, invalidEmailLink = false, openLink = false }: {
  account: RecoveryAccount | null; loading: boolean; links: PortalLinks;
  invalidEmailLink?: boolean;
  openLink?: boolean;
}) {
  const [verifiedAccount, setVerifiedAccount] = useState<RecoveryAccount | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const readLink = useRef(false);
  const account = verifiedAccount ?? linkedAccount;
  const choosingPassword = !!account || (openLink && linkToken !== "");
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""), [mfaCode, setMfaCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(invalidEmailLink
      ? "Mejllänken är ogiltig, har gått ut eller har redan använts. Begär ett nytt återställningsmejl."
      : ""),
    [notice, setNotice] = useState(""), [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!openLink || readLink.current) return;
    readLink.current = true;
    const token = new URLSearchParams(location.hash.slice(1)).get("token_hash");
    history.replaceState(null, "", "/activate?reset=link");
    if (token && /^(?:pkce_)?[a-f0-9]{56}$/.test(token)) setLinkToken(token);
    else {
      setLinkToken("");
      setError("Öppna länken från återställningsmejlet igen eller begär ett nytt mejl.");
    }
  }, [openLink]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setNotice("");
    if (choosingPassword && password !== confirmation) {
      setError("De två lösenorden behöver vara lika."); return;
    }
    setBusy(true);
    try {
      if (account || linkToken) {
        const result = await request(account
          ? { action: "changePassword", accountId: account.accountId, password, mfaCode: mfaCode || undefined }
          : { action: "resetWithLink", tokenHash: linkToken, password });
        if (result.recovery) {
          setVerifiedAccount(result.recovery);
          setLinkToken("");
          setError(result.passwordError ?? "");
          history.replaceState(null, "", "/activate?reset=change");
          return;
        }
        setPassword(""); setConfirmation(""); setMfaCode(""); setChanged(true);
        setLinkToken("");
        history.replaceState(null, "", "/activate");
        setNotice(result.signedOut
          ? "Lösenordet är ändrat och dina tidigare sessioner har avslutats. Logga in igen med ditt nya lösenord."
          : "Lösenordet är ändrat, men utloggningen kunde inte bekräftas. Logga ut på dina andra enheter och logga in igen.");
      } else {
        await request({ action: "resetPassword", email });
        setNotice("Om kontot kan återställas får du ett mejl med en länk. Kontrollera även skräpposten.");
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <main className="activation-shell">
      <section className="activation-card">
        <a className="brand" href={links.administration}>
          <span className="brand-mark"><Heart /></span>
          <span>Go<span>Health</span><i>.</i></span>
        </a>
        <div className="auth-icon"><LockKeyhole /></div>
        <p className="eyebrow">DITT GOHEALTH-KONTO</p>
        <h1>{changed || choosingPassword ? "Välj ett nytt lösenord" : "Återställ lösenordet"}<span>.</span></h1>
        {!changed && <p>{account
          ? `Återställning för ${account.email}. Välj ett nytt GoHealth-lösenord med minst 12 tecken.`
          : choosingPassword
            ? "Välj ett nytt GoHealth-lösenord med minst 12 tecken."
            : "Ange kontots e-postadress för att få ett återställningsmejl."}</p>}
        {error && <div className="alert error" role="alert">{error}</div>}
        {notice && <div className="alert success" role="status">{notice}</div>}
        {changed ? (
          <>
            <p><a href={links.clinical}>Logga in i vårdportalen</a></p>
            <p><a href={links.administration}>Logga in i administrationen</a></p>
            <p><a href={links.activation}>Aktivera en väntande behörighet</a></p>
          </>
        ) : (
          <form onSubmit={submit}>
            {choosingPassword ? <>
              <label>Nytt lösenord
                <input type="password" autoComplete="new-password" required minLength={12} maxLength={200}
                  value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label>Bekräfta nytt lösenord
                <input type="password" autoComplete="new-password" required minLength={12} maxLength={200}
                  value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
              </label>
              {account?.mfaRequired && <label>Kod från kontots autentiseringsapp
                <input inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6}
                  value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
              </label>}
              <p className="muted">Dina tidigare inloggningar avslutas när lösenordet ändras.</p>
            </> : <>
              <label>E-postadress
                <input type="email" autoComplete="username" required maxLength={254}
                  value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
            </>}
            <button className="button primary" disabled={busy || loading || (openLink && linkToken === null)}>
              {choosingPassword ? "Spara nytt lösenord" : "Skicka återställningsmejl"} <ArrowRight size={17} />
            </button>
            {choosingPassword && <p><a href={`${links.activation}?reset=1`}>Begär ett nytt mejl</a></p>}
            <p><a href={links.activation}>Till inloggning och aktivering</a></p>
          </form>
        )}
      </section>
    </main>
  );
}

# GoHealth – systemöversikt

Översikt ligger först i administrationens meny och öppnas vid inloggning. Kartan visar Supabase i centrum, Admin-portalen, Clinician-portalen, GoHealth iOS och Hemläkare.se. Klick på en portal visar personalbehörigheter i den valda mottagningen, med namn, roll, e-post och aktiv/inaktiv status. Aktiv avser behörighet, inte närvaro eller en pågående inloggning. Kliniska uppgifter ingår inte.

## Aktuellt underlag

System och anslutningar kommer från `clinical_private.system_integrations`. Kartan beräknar placering och anslutningslinjer från varje svar. `connected=false` visas utan databaslinje. `enabled=false` tar bort systemet ur kartan. Nya registerrader visas automatiskt utan ändringar i frontend. Registret uppdateras av en betrodd databasoperatör som del av varje integrationsändring; kartan upptäcker inte oregistrerade anslutningar på egen hand.

Personallistor och exakta räknare läses direkt från respektive mottagnings tabeller, via `clinician_system_overview`. Listorna är sidindelade med 50 behörigheter per sida. Resultatet påverkas inte av patientsökning eller administrationssidans äldre listgräns. Ingen service-role-nyckel används. Direktåtkomst till registret är spärrad; RPC:n kontrollerar levande session, befintlig inloggningspolicy och aktiv administratörsroll i efterfrågad mottagning. Anonyma, kliniska roller och andra mottagningars administratörer nekas.

Vyn hämtar data vid öppning, byte av mottagning, personaländringar, återgång till fliken, återfådd internetanslutning och var 30:e sekund när fliken är synlig. Uppdatera hämtar manuellt. Ett anrop får högst 15 sekunder. Vid hämtningsfel visas ett fel och eventuell tidigare bild markeras som inaktuell. Vid 401/403 rensas tidigare data. Begäranden avbryts vid byte av underlag, och gamla svar får inte ersätta nya. Pollning skapar inga upprepade administrationshändelser.

Ansluten betyder registrerad databasanslutning. Kartan är inte en driftmonitor och bevisar inte att varje fristående klient är tillgänglig just nu. Hemläkare.se är registrerad som fristående satellit. iOS har verifierats i GoHealthApp.swift mot samma Supabase-projekt.

## Ändra systembilden

Den som genomför en verklig integrationsändring uppdaterar samtidigt registret. Exempel, först efter att Hemläkare.se faktiskt har kopplats till GoHealths databas:

```sql
update clinical_private.system_integrations
set connected = true,
    description = 'Publik webbplats med GoHealths databasanslutning.'
where id = 'hemlakare';
```

`updated_at` uppdateras automatiskt. För att lägga till ett system används en ny rad med unikt `id`, `name`, `kind`, `description`, `connected` och `sort_order`. Inaktivera med `enabled=false` om ett system tas ur bruk. Anslutningsstatus ändrar enbart schemat; den ger inga nya behörigheter eller tekniska databasanslutningar.

## Leverans och verifiering – 21 november 2026

- Migrationsfil: `20261121151020_administration_overview.sql`, installerad i GoHealth Dev.
- 33 modell- och säkerhetstester, typkontroll och produktionsbygge godkända lokalt. I den begränsade miljön kördes testerna med `node --import tsx --test tests/*.test.ts`, eftersom tsx-kommandots IPC-socket blockeras.
- SQL-sviter godkända i isolerad PostgreSQL. Översiktens SQL-svit är även godkänd mot GoHealth Dev inom transaktion med rollback. Syntetiska testkonton sparas inte.
- Översiktssviten testar exakta räknare över en sidgräns, sidindelning, mottagningsseparering, klinisk/admin-separering, privat register, MFA/lösenordsbeta, återkallelse samt ändrade, nya och borttagna integrationer.
- Visuell och interaktiv webbläsarkontroll återstår: den lokala serverns lyssningsport blockeras av körmiljön, och webbläsaren tillåter inte en lokal file:-förhandsvisning. Statisk serverrendering av vyn har lyckats.
- Webbändringen är förberedd för publicering; produktionens gränssnitt är ännu inte uppdaterat.

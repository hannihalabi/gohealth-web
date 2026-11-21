# GoHealth Web

Admin och Clinician är två arbetsytor i samma Next.js-projekt.

## Kör lokalt

1. Öppna mappen `clinician` och kör `npm ci`.
2. Kopiera `.env.example` till `.env.local` och ange adress och publishable key för ditt Supabase-projekt.
3. Kör `npm run dev`. Clinician finns på `http://127.0.0.1:3040/` och Admin på `http://127.0.0.1:3040/admin`.

På Vercel väljer du `clinician` som rotmapp. `APP_ORIGIN` och `ADMIN_ORIGIN` konfigurerar portalernas domäner. Databasens schemamigreringar och tester finns i `supabase/`. Stäm av migreringshistoriken innan du tillämpar dem på ett befintligt projekt.

Kör `npm run typecheck`, `npm test` och `npm run test:database` från `clinician/`.

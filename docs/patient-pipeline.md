# Patientflöde

Migrering: `supabase/migrations/20261121200000_patient_pipeline.sql` (tillämpas manuellt före publicering).

- **iOS-appen** anropar `gohealth_complete_onboarding(p_name, p_identity)` när patienten är klar med onboarding. Patienten hamnar under Onboarding i administrationen tills en administratör godkänner eller avslår.
- **Hemläkare.se** anropar `submit_application(p_name, p_email, p_message)` (anonymt) från ansökningsformuläret. Samma e-postadress sparas en gång tills ansökan är hanterad.
- **Administratörer** läser flödet med `clinician_patient_pipeline` och beslutar med `clinician_decide_pipeline`. Godkännande kräver bekräftad identitet och skapar patienten i mottagningen.
- **MRR** hämtas från Stripe senare och visas inte förrän dess.

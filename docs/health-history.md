# Complete health history

The clinician portal reads the full stored history through `clinician_vitals_v2`. Overview counts and first/last dates are not limited to a recent preview. Raw history is paginated with a stable (end_at, id) cursor, 200 records per page, and can be reached through a date jump in the UI. An empty metric is shown as unavailable, never as a normal value.

Supported streams: pulse, resting pulse, SDNN HRV, RMSSD HRV when available, respiratory rate, oxygen saturation, VO2 max, body mass, body temperature, FEV1, FVC, PEF, raw steps, walking/running distance, active energy, flights, sleep stages, awake/in-bed intervals and workout duration/activity type. Previously shared daily step totals remain separate from raw step samples; raw activity from overlapping sources must not be summed as a trusted daily total.

Original timestamps, units, source identifiers and manual-entry provenance are preserved. The latest Swedish noon-to-noon sleep night is calculated by unioning overlapping asleep intervals before summing. Individual intervals remain available for analysis. There is no external AI transmission or AI inference in this release.

## iOS dependency

The companion change is prepared in [gohealth-ios PR 1](https://github.com/hannihalabi/gohealth-ios/pull/1). It adds an explicit opt-in for all supported readable history, starting disabled. Existing limited-sharing preferences remain intact. New predicate-free, per-account/type versioned anchors import history in interleaved 500-object pages and are checkpointed only after upload. Source deletions propagate. Reimport is available after a change in HealthKit read permissions.

The updated iOS app must be built, installed and used to opt in before previously unshared values or older phone history can appear in the portal. The computer connection became unavailable during implementation; final Swift compilation and physical-device backfill are outstanding. Raw availability is limited by the patient's HealthKit permissions and the data stored on the phone; a successful empty query cannot distinguish denied permission from missing data. Garmin-only metrics require their own source integration.

## Database and validation

Migration `20261121164034_all_health_history` is installed in GoHealth Dev. Existing ingestion and patient/record commands remain available.

Validation passed both on an isolated PostgreSQL engine during the Vercel build and against the hosted development database in a transaction with rollback: history to 2010, more than 500 samples, stable pagination for tied timestamps, idempotency, canonical-unit validation, null rejection, source/manual metadata, unioned sleep duration, deletion/tombstone behavior, patient isolation, relationship revocation and expired-session rejection. The hosted after-check found zero temporary fixture accounts.

This is data transport and retrieval support for a future authorized analysis, not a verified AI model or a declaration that every source has finished importing.


## Automatic synchronization

The app now derives its raw transfer descriptors directly from HealthStore's quantity definitions and read types. No second per-metric transfer list is maintained. Every item in the app's HealthStore.readings is captured as a display value; histories of app-derived values are discovered from metricHistory. New metrics in these shared models appear in the portal without another backend enum or portal catalogue change. Raw HealthKit measurements retain source UUID, original time, unit, source revision and manual-entry metadata. Display values retain their text and explicitly distinguish observation time from measurement time.

There are no selective pulse/step/full-history sharing toggles in this implementation. Linking Apple Health to the verified account enables automatic sharing to that account's care team. Demo fixtures never enter this pipeline. Actual readability and background execution remain governed by iOS and the user's HealthKit permissions; this is eventual synchronization, not a real-time monitoring guarantee.

Raw imports use per-account/type v3 anchors with no date predicate. The app checkpoints only acknowledged pages, interleaves streams, retries failures, and records incomplete/complete status. Display changes use a protected per-account disk outbox excluded from device backups. The outbox preserves exact event IDs across retries and app restarts; acknowledgements remove only accepted events. Recurrent A-B-A changes remain distinct. Deletion tombstones cover both legacy and v3 raw rows and survive reimport.

The portal lists actual received metric types dynamically and shows app display histories separately from raw samples. Its current-values panel preserves unavailable strings instead of treating them as zero. New private tables have RLS enabled and no direct client table permissions. Gateways enforce live sessions, self-owned ingestion, active clinician membership and active patient assignments. Existing legacy contracts remain available.

Validation: Swift app type checking and Xcode's build for IPHONE24 succeeded. Protected-outbox lifecycle tests passed. Unit tests, database regression suites including care-team checks, and the production web build passed. The same automatic-sync SQL assertions passed on GoHealth Dev inside a rolled-back transaction. Running on the physical phone was waiting for IPHONE24 to be unlocked at publication time; a real post-install phone-to-portal backfill was not yet verified.

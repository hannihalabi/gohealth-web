# Automatic app-to-clinician synchronization

All non-demo HealthStore readings are shared automatically once Apple Health is linked to the verified account. There are no per-metric sharing switches. Raw transfer descriptors come from the same quantity definitions and read types as the app UI. New measurements added to these shared models need no second ingestion enum or portal catalogue entry.

Every current HealthStore reading is also preserved as an app display value. Histories of derived/app-only values are discovered from metricHistory. Display values retain their original text; observation time is explicitly distinct from measurement time. Missing values stay unavailable rather than becoming zero. Raw values preserve original sample UUID, time, unit, source revision, device identifier when available and manual-entry provenance. Demo fixtures never enter the pipeline.

## Reliability and history

Raw HealthKit queries use versioned per-account/type anchors without a date predicate. Streams are interleaved, and an anchor advances only after upload acknowledgement. Deletion tombstones cover legacy and new raw rows and prevent reimport from reviving removed samples.

App display changes use a per-account disk outbox with file protection, excluded from backups. Exact event IDs survive retries/restarts; only acknowledged events are removed. Recurrent A-B-A changes and same-time readings from different sources remain distinct. Failures are retried and the portal exposes syncing/complete/retrying state.

The portal discovers actual received metric types dynamically. Raw history and app display history are paginated without a fixed age cutoff. Raw history supports jumping to an older date. The latest Swedish sleep night is calculated by unioning overlapping asleep intervals before summing.

Apple Health read permissions and iOS execution opportunities still determine what can be read and when background work can run. This implements eventual automatic synchronization, not real-time monitoring. If the app is force-quit, the phone is locked before first unlock or permissions are denied, synchronization may wait for the next permitted execution.

## Backend and access

Migration `20261121203559_automatic_health_sync` is installed in GoHealth Dev. The app calls `gohealth_sync_health_v3`; the clinician portal calls `clinician_health_v3`. Private tables have RLS and no direct client table privileges. The gateways enforce live sessions, verified self-owned ingestion, current clinician membership and active patient assignment. Older v1/v2 contracts continue working.

The implementation does not transmit health data to an external AI provider or perform a new AI analysis. It preserves structured raw and derived inputs for future authorized analysis.

## Verification and rollout

Protected-outbox lifecycle tests passed. Swift type checking and Xcode's build for IPHONE24 succeeded. Web unit tests, full database regressions including current care-team/patient-pipeline tests, and the production build passed. Automatic-sync assertions also passed against hosted GoHealth Dev in a transaction with rollback; no fixture accounts remained. Tests cover unknown future metrics, history to 1901, stable pagination beyond 500 rows, zero versus missing values, idempotent retries, source histories, legacy deduplication, tombstones and care-relation isolation.

iOS main contains `8f8460d9dd1eb6a56a48b113b0f548b45d19aee6`; the older opt-in draft PR 1 is superseded by this implementation. Web release `f78ec37c7a9e1423e1b74502b624f7eb9f6bf4e2` reached READY on the clinician/admin domains. At the last physical-device step, Xcode was waiting for IPHONE24 to be unlocked before launch. Until that occurs, actual post-install phone-to-portal backfill is not yet verified.

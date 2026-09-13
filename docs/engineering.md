# Engineering

Run `yarn validate` with `TEST_DATABASE_URL` pointing at a disposable migrated
PostgreSQL database. Schema changes are forward-only and the canonical snapshot
hash is verified during clean provisioning. Financial arithmetic uses `bigint`;
JSON and contracts use strings. Never log posting payloads or credentials.

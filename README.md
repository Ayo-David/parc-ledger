# Parc Ledger

Tenant-isolated double-entry accounting service built with Express, strict
TypeScript, Knex, and PostgreSQL. L-01 provides synchronous, atomic posting with
integer minor units, database-enforced balancing and immutability, idempotent
replay, cached balances, audit records, and a transactional outbox.
L-02 adds idempotent customer and tenant account provisioning, with separate
accounts per purpose and currency; NGN is the only enabled operational currency.

## Local development

Copy `.env.example` to `.env`, set a random internal service token, then run:

```sh
yarn install --frozen-lockfile
yarn migrate:latest
yarn dev
```

Do not use production credentials locally. The internal posting and account
provisioning APIs are `POST /internal/v1/postings` and
`POST /internal/v1/accounts`; callers must provide
`X-Internal-Service-Token`, `X-Calling-Service`, `X-Tenant-Id`, and
`Idempotency-Key`.

Holds are created at `POST /internal/v1/holds`, released at
`POST /internal/v1/holds/{id}/release`, and captured with a balanced posting at
`POST /internal/v1/holds/{id}/capture`. Capture cannot be retried with changed
instructions under the same idempotency key.

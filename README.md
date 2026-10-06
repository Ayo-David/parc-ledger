# Parc Ledger

Tenant-isolated double-entry accounting service built with Express, strict
TypeScript, Knex, and PostgreSQL. L-01 provides synchronous, atomic posting with
integer minor units, database-enforced balancing and immutability, idempotent
replay, cached balances, audit records, and a transactional outbox.
L-02 adds idempotent customer and tenant account provisioning, with separate
accounts per purpose and currency; NGN is the only enabled operational currency.

## Local development

Copy `.env.example` to `.env`, set this service's client key and the Auth
JWKS/issuer, then run:

```sh
yarn install --frozen-lockfile
yarn migrate:latest
yarn dev
```

Do not use production credentials locally. The internal posting and account
provisioning APIs are `POST /internal/v1/postings` and
`POST /internal/v1/accounts`; callers must provide
`Authorization: Bearer <token>`, `X-Calling-Service`, `X-Tenant-Id`, and
`Idempotency-Key`.

Tokens are short-lived, audience-bound (`parc-ledger`) JWTs issued by Auth &
Customer and verified through its JWKS by `src/security/parc-service-auth.ts`.
Ledger derives the caller from the token's `client_id` and rejects a mismatched
`X-Calling-Service` with `403`. Endpoint permissions are declared in
`ledgerAccessPolicies`: postings and holds accept Lending, Payment and Savings;
manual adjustments require a delegated administrator via the Admin BFF; and
customer-delegated reads are limited to that customer's own wallet and
statements. A delegated token carries the end user, while background work uses
service-only tokens. Static shared secrets and `X-Internal-Service-Token` are
not accepted.

Holds are created at `POST /internal/v1/holds`, released at
`POST /internal/v1/holds/{id}/release`, and captured with a balanced posting at
`POST /internal/v1/holds/{id}/capture`. Capture cannot be retried with changed
instructions under the same idempotency key.

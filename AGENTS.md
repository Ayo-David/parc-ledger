# Ledger service instructions

## Ownership

Own ledger entities and books, chart of accounts, journals, transactions, entries, balances, posting rules, accounting periods and ledger inbox/outbox processing. Own only the `parc_ledger` database.

## Non-negotiable accounting invariants

- Every posted transaction is balanced per ledger book and currency: total debits equal total credits.
- Posted financial records are append-only. Correct mistakes with reversal and replacement transactions; never update/delete history.
- Posting is atomic, idempotent and concurrency-safe. The same business idempotency key cannot post twice.
- Account, book, tenant, currency and status must be compatible before posting.
- Balances are derived/cached outcomes of entries, not an independent source of truth. Updates occur in the same transaction as posting.
- Monetary values use exact integer minor units or an explicitly approved exact numeric model—never floating point.
- External services request postings through contracts; they never write ledger tables.

## Database and delivery

- Canonical migrations: `db/migrations/`; generated snapshot: `db/schema/current.sql`.
- Schema changes require explicit invariant, locking, backfill, reconciliation and rollback/forward-fix analysis.
- Prefer constraints that make invalid accounting state unrepresentable. Partition only with measured need and a documented retention/maintenance plan.
- Test balancing, duplicate requests, reversal chains, simultaneous postings, period closure, tenant isolation, outbox atomicity and reconciliation.
- Treat ledger API/event and posting-rule changes as high risk; explain accounting impact at handoff.

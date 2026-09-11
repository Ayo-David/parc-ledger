# Ledger domain

Ledger owns books, chart-of-account records, journals, entries, cached balances,
accounting periods, audit records, and its inbox/outbox. Other services request
postings through the internal contract and never write this database.

Every posting is balanced within one tenant, book, and currency. Amounts are
positive integer minor-unit strings at the boundary and PostgreSQL `BIGINT`
internally. Account rows are locked in UUID order, the journal and entries are
written atomically, balances are refreshed from posted entries, and the event is
stored in the same transaction. Completed postings and their entries are
immutable; corrections require later reversal work in L-04.

L-02 provisions customer and tenant accounts through a tenant-scoped internal
command. Each active primary book receives one mapping per purpose and ISO
currency. Creation is protected by both command idempotency and a natural-key
lock; it emits `ledger.account-created.v1` in the same transaction. The schema
is currency-separated from day one, while provisioning permits NGN only until
currency-specific provider integration is available.

L-03 reserves funds through expiring account holds. A hold reduces only the
available cached balance; it does not create a journal entry. Release and expiry
restore availability. Capture supplies a balanced posting that consumes the
complete reserved amount and atomically records its immutable transaction link.

L-04 performs full compensating reversals only: it mirrors every posted entry,
preserves the original record, and permits one immutable reversal link. Manual
adjustments require a payload-bound Tenant Admin maker-checker approval before a
balanced posting is created; Ledger reports a failed execution back to Tenant
Admin when its local transaction cannot commit.

L-06 records rather than repairs integrity drift. It compares cached balances to
posted-entry outcomes and persists idempotent evidence. Reconciliation preserves
source hashes and creates reviewable exceptions; remediation remains an approved
reversal or adjustment.

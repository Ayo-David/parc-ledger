# Runbook

Migrate before starting the service. Readiness requires PostgreSQL connectivity.
Treat idempotency mismatch, unbalanced posting, closed-period rejection, and
immutability violations as non-retryable. Treat transient database failures as
retryable with the original idempotency key. Never repair a completed posting by
updating or deleting it; post a compensating reversal after L-04 is available.

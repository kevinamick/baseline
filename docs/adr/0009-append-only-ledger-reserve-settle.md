# Append-only usage ledger with reserve/settle semantics

Eval Point consumption (and the Optimization Run allowance) is recorded in an append-only ledger, not a mutable balance column. A run's full point cost — exactly computable at creation as `rows × (base + per-criterion)` — is **reserved** atomically when the run is created, and **settled** at its terminal state: completed runs settle for the full reservation, failed runs settle for the rows actually executed and release the remainder. Optimization Runs reserve one unit of the run allowance the same way.

Reserve-at-creation is what makes quota enforcement race-proof: the check and the debit are one atomic operation, so concurrent runs cannot jointly overshoot a hard cap (the Free plan's "Hard Limit Stop"). Settle-at-terminal is what makes it fair: nobody pays full price for a run that died at row 30. The alternatives fail one or the other — debit-at-creation overcharges failures unless you bolt on refunds (settlement built badly), debit-on-completion lets concurrent runs race past hard caps and forces an ugly mid-run-exhaustion state.

Append-only is a transparency requirement (ADR-0008's decision principle), not a style choice: the ledger a customer sees (`−700 reserved → −210 settled, +490 released`, period grants, overage) is the audit trail itself. A mutated balance cannot explain how it got there.

# R-004 rollback and recovery boundary

CORE_V0_ENABLED is the rollout control. Before production promotion it stays
disabled and /api/chat/stream remains unchanged. If the target path shows
schema, Memory, model, read-view or commit anomalies, disable the flag and
preserve the previous deployment. Do not copy Core rows into JSON as an
emergency projection.

An in-flight target request is not declared successful by rollback. Its Core
and Memory identities must be reconciled using the R-003 receipt and repair
protocol before retrying.

This package proves local rollback policy and request read parity only. Live
deployment switching, old-writer fencing, backup restore and production
Auth/TLS are separate promotion gates.

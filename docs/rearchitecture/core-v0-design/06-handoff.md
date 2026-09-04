# Design handoff

## Current outcome

The design is awaiting one independent adversarial pass plus steelman. This package must not authorize implementation while a blocking finding is open or while the review report and consumption ledger are absent.

## Required evidence before implementation

- consumed review report and ledger with matching finding IDs;
- every blocking finding closed with an evidence path or an explicitly approved exception;
- synchronized plan status, package manifest and handoff record;
- implementation package with a frozen L3 contract;
- one legacy fixture and one target fixture for the same chat scenario;
- failure tests for duplicate submit, degraded retrieval, failed assistant commit and restart of pending projection.

## Next task

`R-001-REVIEW-CONSUME`: persist the independent report, consume each finding into the owning artifact, update the plan's status text, and run the package checker.

## Stop / continue decision

Continue to implementation only if the review gate is mechanically satisfied. Otherwise run one bounded repair or revise the target; do not open a replacement PR and do not close old PRs based on prose alone.


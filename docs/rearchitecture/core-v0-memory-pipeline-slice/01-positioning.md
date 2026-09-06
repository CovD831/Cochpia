# R-005 positioning

## Why now

The R-004 closure left the loop "chat stores memory" proven but the loop
"memory changes replies" open. The memory-loop proof isolated the two missing
steps and showed every other mechanism works. This slice is the smallest
change that closes the MVP loop: wire extraction and projection, expose
recall semantics, and turn the manual proof into an automated gate.

## What this slice is not

It is not the Memory Alpha gate (Phase 3), not the deletion story (R-006),
and not a quality claim. A recall hit on a toy fact is an architectural
proof, not a retrieval-quality evaluation.

## Relation to the proof

`scripts/memory-loop-proof.js` stays in the repository as the executable
specification of the loop. In this slice it gains an automated variant:
E6's manual candidate creation, promotion and snapshot row insertion must
happen through the production turn path instead, and E4's cross-session
reply must take the memory branch without any emulated step.

## Success in one sentence

A user states a fact in one session; in a brand-new session the assistant's
reply demonstrably uses it, with no step performed by hand.

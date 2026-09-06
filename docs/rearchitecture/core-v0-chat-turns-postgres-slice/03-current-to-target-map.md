# R-004 current-to-target map

| Current hotspot | R-004 action | Current owner | Target owner | Advance gate |
|---|---|---|---|---|
| coreV0ServiceForRequest uses createInProcessMemoryPort | adapt behind production adapter | App Runtime process state | Core plus PostgreSQL Core and Memory boundaries | target acceptance |
| store.js private PostgreSQL pool | expose one accessor | store.js | store.js remains pool owner | pool identity test |
| POST /api/chat/turns | retain endpoint and switch by provider | App Runtime | Core v0 route with PG adapter under flag | paired parity fixture |
| session messages | hydrate the Core read view in PG mode | JSON state | Core Store hydration view | fresh-request parity |
| channel counts | use the same hydrated view | JSON state | Core Store hydration view | channel parity |
| session metadata | retain compatibility owner | cochpia_user_states | cochpia_user_states | later authority decision |
| /api/chat/stream and legacy writers | preserve unchanged | legacy runtime | legacy runtime | named stream slice |

The target route does not write Core results back into JSON user-state
messages. PostgreSQL mode hydrates Core messages for reads; JSON mode retains
the R-002 behavior.

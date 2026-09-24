# World Telegram local E2E verification

Verified on September 14, 2026 against a local UniFi fork (chain 2092151908), World account 21, and `@world_local_test_bot`.

## Verified

| Area | Evidence |
| --- | --- |
| Web handover | Composite QR claim, owner grant, and agent activation completed through the real Telegram bot. |
| Agent execution | Sale confirmed in transaction `0x9a292add4d9b4b17330a0bfd63ab56c16cc3b29812af02abc49aac9dcbfc57fd`, block 19316308. Receipt status and EntryPoint UserOperation success were both successful. |
| Holdings | Fresh partner SDK read: 1024.9991 USDT and 0.04 WETH; NAV 1125.1211. |
| Custom commands | `/b` reported $1,125.12; `/p` reflected the updated holdings. `/r`, `/a`, `/d`, `/tasks`, `/app`, and `/chart WETH w` were exercised during the run. |
| Fill index | Account 21 fill row matched the receipt and block; the cursor advanced to 19316309. |
| Mini app | User screenshot showed the updated $1,125.12 portfolio. |
| Draft handoff | User confirmed a Products trading action prefilled the bot composer. Desktop link testing also confirmed it did not send automatically. Back to chat itself intentionally has no draft text. |

## Unverified or deferred

| Area | Remaining work |
| --- | --- |
| Slow fork and final replies | A later buy's fork storage read stalled past the backend Telegram stream's 60-second deadline. Simulation then failed and the final error did not reach the chat. Fix backend timeout/late-result delivery and retest; no buy was submitted in that attempt. |
| Signing-service reliability | A Para request timed out once; an explicit retry resumed the same durable operation and succeeded. Broader outage/recovery testing is pending. |
| Approval wording | Backend tool guidance was corrected after an automatic-signing response incorrectly said wallet approval was pending. A fresh trade has not revalidated that wording. |
| Production and Privy | No production deployment, production transaction, Privy migration, or staging soak is claimed by this local test. |
| Wider coverage | Additional phone/client versions, adverse-network scenarios, watch workflows on the real bot, and all order types remain future coverage. |

## Cleanup plan

1. Review and land the coordinated backend, Composite, World plugin, and service PRs; keep unresolved E2E items explicit.
2. Keep fork snapshots and receipt evidence until subsequent reliability tests finish.
3. Separate disposable local configuration and test fixtures from production defaults; preserve owner/account/provider authority checks.
4. Rotate the two test bot tokens exposed during setup, update their configured consumers, and re-register the webhook. Do this as a coordinated operation so the running rig is not silently broken.
5. After testing, stop only the owned local services and tunnels, then remove ignored generated caches and ephemeral state after preserving necessary evidence.

The service implementation and fixes through `6c0378b` were already pushed to `main` before PR preparation. This document records their verification and follow-up boundaries; it does not reintroduce those changes as a new implementation diff.

# Accounts

A wallet owns the account (deposit, withdraw, grant/revoke traders). Sub-accounts isolate risk at the cost of capital efficiency.

**Trade-only.** Owner-designated traders can trade and cannot deposit or withdraw. Revocation is immediate on the next tool call. Use `get_world_agent_permission` for grant status. Prefer handover context; do not re-ask an ID a tool already resolved. Never request a private key, seed, or signing credential.

**This app.** Mandate-aware and non-executable (v0.3): read, preview, check mandate. A policy `allow` is still `executable: false`. Do not describe a preview as an order or fill. Official World Agent (Telegram, routine unsigned execution) is a different product: https://docs.world.inc/ai-agents/world-agent.md

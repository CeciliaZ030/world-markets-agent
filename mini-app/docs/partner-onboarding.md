# Partner onboarding

1. Deploy this repository to Vercel and set the variables in `.env.example`.
2. In Aomi Build, register the Telegram bot, select the World application, set its tenant base URL to `https://api.world.inc/mini-app`, and list the supported commands.
3. Give the Aomi backend and this Vercel project the same `AOMI_TELEGRAM_TENANT_SECRET`.
4. Set `AOMI_TELEGRAM_BINDING_URL` in Vercel to the bot-scoped canonical Aomi binding endpoint. Keep that capability server-side.
5. Keep the existing signed handover flow. Aomi receives `/start`, claims the handover, and remains the only Telegram webhook owner.

Deploy the backend first, then the Vercel app. No worker, webhook takeover, onboarding CLI, service database or scheduler is involved.

Verify real Telegram claim, mini-app display, activation, trade receipt, and revoked/expired access before declaring delivery complete.

Partner commands remain slash-only and DM-only, excluding Aomi's built-ins, with a hard character budget per reply.

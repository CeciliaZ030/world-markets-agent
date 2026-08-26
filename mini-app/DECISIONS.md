# Mini-app task ledger — spec vs this repo

- **Compose transport.** v3 `sendData` did not exist. Client path is `Telegram.WebApp.sendData`; local/dev and the host webhook land on `POST /api/v1/mini-app/compose`. No mutating `/ledger*` route.
- **Watcher.** Wrapped `brain/src/watches.js`; did not build a second evaluator.
- **Confirm gate.** Signed TTL'd buttons stay on the Aomi host. `pause_world_watch` / `resume_world_watch` / `set_world_watch` run only after that confirm. The mini app never hosts a confirm.
- **Pause.** Spec default: draft to the thread, flip to `paused` only after the signed confirm.
- **Cancel.** Ledger × sends whole-message `cancel task {id}` in the background (`sendData` is not used, so the mini app stays open). Host `render_lookup` skips the LLM and drops the watch — not a trade, no signed confirm. Chat echo is the bot posting the command and the result.
- **Voice notes.** Hold-to-talk on the ledger posts `POST /api/v1/mini-app/voice` (not `sendData`). Mini App proxies audio to The Desk `/api/voice/note`; Cage assent remains the spoken word `Done`. If `getUserMedia` is blocked, copy points at a Telegram thread voice note. LiveKit duplex is not used in the WebView.
- **Desk context.** `GET /api/v1/desk/context` is the live book The Desk reads (session or `X-Desk-Token`). It is not a ledger write.
- **Job-line negative form.** `WORLD_MINI_JOBLINE_NEGATIVE` default off.
- **Expiry / visibility.** 30-day watch TTL (existing); 90-day ledger visibility for done/expired.
- **Executing / TWAP.** No fabricated fill ticks. Executing rows render only when the ledger has real progress fields.
- **Digest.** Skill copy in §6.14 (tightened to fit the 8k skill budget). Labor line from `ledger.labor` when holding>0; startapp `i_`+id. No new push channel.
- **Event store.** Brain JSON files, same as watches. No Graphiti in this repo.
- **Layout.** Ledger primary, portfolio secondary (owner call; `flag.primary_view`).
- **Search.** Global nav, not portfolio-only. Catalog is every live spot / perp / lend book.

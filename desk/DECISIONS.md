# The Desk — v0 decisions

Every deviation from `THE_DESK_V0_BUILD_SPEC.md`, one line, with reason.

- Trading venue is World Markets (spot/perp via Aomi), not US equities/ETFs — operator direction; spec's equity-only clause yields to the product this repo already executes.
- `quantity.kind` uses `base` (World size) instead of `shares`; spoken unit is the asset name. Spec examples that say "shares of Apple" are rewritten in tests to WETH/WBTC.
- Paper execution is an in-process book with immediate fills (config `immediate_paper_fills`). Proves the order loop without a live-money or even testnet submit. Live `execute_world_order` is not called in v0; Cage refuses to boot if `paper_mode` is false.
- Aomi *policy* mandate (markets, notional cap, RAPV floor) is loaded from the same JSON the plugin uses and checked in the Cage before submit. Spec *delegation* mandates (price triggers) are a separate object (`MandateDraft`) — name collision documented, not merged.
- World is 24/7 — no equity session calendar, no extended-hours readback clause.
- "Limit at bid minus a dime" default for trigger orders is **10 bps** below the trigger (a dime is noise on ETH marks).
- Design bible is at `~/Desktop/THE_DESK_DESIGN.md`; tapes 2/4/5/6/7 still not pasted into `prompts/desk_system.md`.
- `the_desk_visuals.html` still missing from disk. Client restyled to §13: one card at a time, arm's-length type, assembling / frozen readback / stamped archive. Pixel-match the HTML when it lands.
- No vendor keys at v0 start: LiveKit/Flux/Cartesia/Haiku are interfaces behind a local WebSocket room + deterministic parser. Same Cage, tape, and cards. Vendors plug in when `.env` is filled.
- Soft-yes teaching line is Cage-owned, not LLM-owned, so it fires without a model.
- Coverage gate is 100% branch on `desk.cage` and `desk.speech` (readback + `speak_text`).

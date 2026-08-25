# The Desk (v0)

Voice-first paper trading client for **World Markets**, executed through Aomi.
The LLM proposes; the **Cage** validates, reads back, and submits. Assent is
the reserved word `done` — never a soft yes.

## Offline loop (no vendor keys)

```sh
cd desk
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
python -m desk serve          # API + WS on :8765
# in another shell:
cd client && npm install && npm run dev
```

Open the Vite URL. Type as the mic (mock STT). Cards and spoken text stream
over the WebSocket.

```
what's ether doing?
buy two tenths of ether, limit three thousand eight hundred
Done
if ether drops below three thousand, sell half
```

Replay a session:

```sh
python -m desk tape replay <session_id>
```

## Paper mode

The process **refuses to boot** unless `paper_mode: true`. Fills never hit the
execution sidecar. Quotes may be live World marks when RPC is reachable;
otherwise the fixture book is used.

LiveKit + Deepgram Flux + Cartesia + Claude are optional extras
(`pip install -e ".[voice]"`) and stay dark until keys are present.

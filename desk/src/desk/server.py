from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from desk.config import DeskConfig, load_config
from desk.persist import Store, TapeLogger, replay_text
from desk.session import DeskSession

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets"


def create_app(config: DeskConfig | None = None, *, store: Store | None = None) -> FastAPI:
    config = config or load_config()
    config.assert_paper()
    data_dir = Path(config.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    store = store or Store(f"sqlite:///{data_dir / 'desk.sqlite'}")
    app = FastAPI(title="The Desk")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    sessions: dict[str, DeskSession] = {}

    def get_session(session_id: str | None = None) -> DeskSession:
        sid = session_id or uuid4().hex[:10]
        if sid not in sessions:
            tape = TapeLogger(store, sid)
            tape.record("session.start", {"config": config.model_dump(mode="json")})
            sessions[sid] = DeskSession(config, tape=tape)
        return sessions[sid]

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "paper_mode": config.paper_mode, "voice_vendors": False}

    @app.get("/api/token")
    def token() -> dict[str, Any]:
        return {"ok": False, "error": "LiveKit keys not configured; using local mock room"}

    @app.post("/api/session")
    def new_session() -> dict[str, str]:
        s = get_session()
        return {"session_id": s.session_id}

    @app.post("/api/inject/{session_id}")
    def inject(session_id: str, body: dict[str, Any]) -> dict[str, Any]:
        s = get_session(session_id)
        text = body.get("text") or ""
        out = s.on_final_transcript(text)
        if body.get("complete_tts", True) and s.interrupt.playing:
            out["tts_complete"] = s.notify_tts_complete()
        return out

    @app.get("/api/tape/{session_id}")
    def tape(session_id: str) -> dict[str, str]:
        return {"text": replay_text(store, session_id)}

    @app.get("/api/latency/{session_id}")
    def latency(session_id: str) -> dict[str, str]:
        s = sessions.get(session_id)
        return {"report": s.latency_report() if s else "no session"}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await websocket.accept()
        session: DeskSession | None = None

        def push(msg: dict[str, Any]) -> None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
            loop.create_task(websocket.send_json(msg))

        try:
            while True:
                data = await websocket.receive_json()
                typ = data.get("type")
                if typ == "hello":
                    session = get_session(data.get("session_id"))
                    session.push = push
                    await websocket.send_json({"type": "hello", "session_id": session.session_id, "paper": True})
                    continue
                if session is None:
                    session = get_session()
                    session.push = push
                if typ == "transcript":
                    out = session.on_final_transcript(data.get("text") or "")
                    await websocket.send_json({"type": "turn", **out})
                    if data.get("auto_complete_tts", True) and session.interrupt.playing:
                        done = session.notify_tts_complete()
                        await websocket.send_json({"type": "tts_complete", **done})
                elif typ == "tts_complete":
                    await websocket.send_json({"type": "tts_complete", **session.notify_tts_complete()})
                elif typ == "tick":
                    for item in session.tick():
                        await websocket.send_json({"type": "tick", **item})
        except WebSocketDisconnect:
            return

    ear = ASSETS / "earcons"
    if ear.exists():
        app.mount("/earcons", StaticFiles(directory=ear), name="earcons")
    dist = ROOT / "client" / "dist"
    if dist.exists():
        app.mount("/", StaticFiles(directory=dist, html=True), name="ui")
    else:

        @app.get("/")
        def root() -> dict[str, Any]:
            return {"ok": True, "hint": "run the Vite client in desk/client"}

    return app


def serve(config: DeskConfig) -> None:
    import uvicorn

    host, _, port = config.bind.partition(":")
    uvicorn.run(create_app(config), host=host or "127.0.0.1", port=int(port or 8765), log_level="info")

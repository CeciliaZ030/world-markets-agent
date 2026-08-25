from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from desk.config import DeskConfig
from desk.persist import Store, TapeLogger
from desk.session import DeskSession
from desk.trading import PaperBroker


@pytest.fixture
def config() -> DeskConfig:
    return DeskConfig(
        paper_mode=True,
        verbosity="expert",
        paper_equity="100000",
        immediate_paper_fills=True,
        mandate_confirmation_window_sec=0,
        aomi_mandate_path="placeholder",
    )


@pytest.fixture
def store(tmp_path: Path) -> Store:
    s = Store(f"sqlite:///{tmp_path / 'desk.sqlite'}")
    yield s
    s.engine.dispose()


@pytest.fixture
def session(config: DeskConfig, store: Store) -> DeskSession:
    tape = TapeLogger(store, "test-session")
    broker = PaperBroker(equity=config.paper_equity, immediate_fills=True)
    return DeskSession(config, tape=tape, broker=broker)


def complete(session: DeskSession) -> dict:
    if session.interrupt.playing or session.cage.state.value == "READBACK":
        return session.notify_tts_complete()
    return {}

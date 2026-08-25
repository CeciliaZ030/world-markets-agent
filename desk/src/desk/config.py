from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field


class DeskConfig(BaseModel):
    paper_mode: bool = True
    verbosity: Literal["novice", "expert"] = "expert"
    quantity_cap_pct_of_equity: Decimal = Decimal("0.25")
    paper_equity: Decimal = Decimal("100000")
    immediate_paper_fills: bool = True
    quiet_hours: list[str] | None = None
    anchor_time: str = "09:30"
    voice_id: str = "cartesia:sonic-3.6:desk-v0-pinned"
    eot_threshold: float = 0.72
    instrument_confidence_threshold: float = 0.9
    assent_timeout_sec: float = 30
    mandate_confirmation_window_sec: int = 300
    mandate_expiry_days: int = 30
    mandate_poll_sec: float = 5
    limit_offset_bps: Decimal = Decimal("10")
    default_product: Literal["spot", "perp"] = "spot"
    default_quote: str = "USDT"
    watchlist: list[str] = Field(default_factory=lambda: ["WETH", "WBTC"])
    aomi_mandate_path: str = "placeholder"
    world_rpc_url: str | None = None
    bind: str = "127.0.0.1:8765"
    data_dir: Path = Path("data")

    def assert_paper(self) -> None:
        if not self.paper_mode:
            raise RuntimeError(
                "The Desk v0 refuses to boot unless paper_mode is true. "
                "Live-money accounts are out of scope."
            )


def _decimalish(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _decimalish(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_decimalish(v) for v in value]
    return value


def load_config(path: Path | None = None) -> DeskConfig:
    path = path or Path(__file__).resolve().parents[2] / "desk_config.yaml"
    raw: dict[str, Any] = {}
    if path.exists():
        loaded = yaml.safe_load(path.read_text()) or {}
        raw = _decimalish(loaded)
    cfg = DeskConfig.model_validate(raw)
    cfg.assert_paper()
    return cfg

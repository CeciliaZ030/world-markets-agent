#!/usr/bin/env python3
"""Local adherence eval (4a) and round-2 probe harness (4c).

Not run in CI — requires the live dev stack (brain + sidecar + aomi-run) and
OpenRouter. Token counts are retained in transcripts (round 1 stripped them).

Usage:
  python3 tests/adherence-eval/run.py eval          # 4a-1 + 4a-2 against account 17
  python3 tests/adherence-eval/run.py probes        # 11 probes, fresh-per-probe
  python3 tests/adherence-eval/run.py probes --long # one ≥20-turn session
  python3 tests/adherence-eval/run.py all           # eval + both probe passes
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SUITE = Path(__file__).resolve().parent
TOOL_RE = re.compile(r"(?:🔧|tool[_\s-]?call|function[_\s-]?call)", re.I)
NUMBER_RE = re.compile(
    r"(?<![A-Za-z_/])(?:\$)?\d[\d,]*(?:\.\d+)?%?(?![A-Za-z])"
)
SHORTCUT_RE = re.compile(r"^/[a-d]$")
BAND_RE = re.compile(r"^/10$")
TOKENS_RE = re.compile(r"\[tokens:[^\]]*\]", re.I)


def plugin_path() -> Path:
    dylib = ROOT / "target/debug/libworld_markets.dylib"
    so = ROOT / "target/debug/libworld_markets.so"
    if dylib.exists():
        return dylib
    if so.exists():
        return so
    raise SystemExit("plugin not built; run cargo build")


def sidecar_ok(port: str, path: str = "/health") -> bool:
    try:
        subprocess.run(
            ["curl", "-sf", f"http://127.0.0.1:{port}{path}"],
            check=True,
            capture_output=True,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def load_spec() -> dict:
    return json.loads((SUITE / "probes.json").read_text())


def run_prompt(plugin: Path, prompt: str, session: str, env: dict[str, str], max_turns: str = "12") -> dict:
    cmd = [
        "aomi-run",
        str(plugin),
        "--env-file",
        str(ROOT / ".env"),
        "--provider",
        os.environ.get("AOMI_PROVIDER", "openrouter"),
        "--session-id",
        session,
        "--max-turns",
        max_turns,
        "--prompt",
        prompt,
    ]
    started = time.time()
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=env)
    return {
        "prompt": prompt,
        "session": session,
        "exit_code": proc.returncode,
        "seconds": round(time.time() - started, 1),
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "token_markers": TOKENS_RE.findall(proc.stdout) + TOKENS_RE.findall(proc.stderr),
    }


def bot_lines(stdout: str) -> list[str]:
    lines = []
    for raw in stdout.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        lower = stripped.lower()
        if lower.startswith("you ▸") or lower.startswith("user ▸"):
            continue
        if stripped.startswith("bot ▸"):
            lines.append(stripped[len("bot ▸") :].strip())
            continue
        if "🔧" in stripped or stripped.startswith("🔧"):
            lines.append(stripped)
            continue
        lines.append(stripped)
    return lines


def first_emitted(stdout: str) -> str:
    for line in bot_lines(stdout):
        if line:
            return line
    return ""


def is_tool_call(line: str) -> bool:
    return bool(TOOL_RE.search(line)) or line.lstrip().startswith("{")


def final_message(stdout: str) -> str:
    emitted = bot_lines(stdout)
    text = []
    for line in emitted:
        if is_tool_call(line):
            continue
        text.append(line)
    return "\n".join(text).strip()


def tool_blob(stdout: str) -> str:
    return "\n".join(line for line in bot_lines(stdout) if is_tool_call(line))


def numeric_literals(text: str) -> list[str]:
    out = []
    for match in NUMBER_RE.finditer(text):
        token = match.group(0)
        if SHORTCUT_RE.match(token) or BAND_RE.match(token):
            continue
        out.append(token)
    return out


def check_first_output_is_tool_call(stdout: str) -> tuple[bool, str]:
    first = first_emitted(stdout)
    if not first:
        return False, "no bot output"
    if is_tool_call(first):
        return True, first
    return False, f"first output was prose: {first[:160]}"


def check_no_foreign_digits(stdout: str) -> tuple[bool, str]:
    message = final_message(stdout)
    tools = tool_blob(stdout) + stdout
    foreign = []
    for token in numeric_literals(message):
        bare = token.lstrip("$").rstrip("%")
        if token in tools or bare in tools:
            continue
        foreign.append(token)
    if foreign:
        return False, f"foreign digits {foreign} in {message[:240]!r}"
    return True, "ok"


def maybe_tiktoken_check() -> dict | None:
    try:
        import tiktoken  # type: ignore
    except ImportError:
        return None
    path = ROOT / "src/skill/turn-contract.md"
    text = path.read_text()
    enc = tiktoken.get_encoding("cl100k_base")
    n = len(enc.encode(text))
    return {"file": str(path), "tokens": n, "ok": n <= 800}


def require_stack() -> None:
    brain = os.environ.get("WORLD_BRAIN_PORT", "8788")
    exec_port = os.environ.get("WORLD_EXECUTION_PORT", "8787")
    if not sidecar_ok(brain):
        raise SystemExit(f"brain not healthy on 127.0.0.1:{brain}; start ./scripts/dev-run.sh first")
    if not sidecar_ok(exec_port):
        raise SystemExit(
            f"execution sidecar not healthy on 127.0.0.1:{exec_port}; start ./scripts/dev-run.sh first"
        )


def env_for_eval() -> dict[str, str]:
    env = os.environ.copy()
    env["WORLD_DEV_SEED_POST_TRADE_RAPV"] = env.get("WORLD_DEV_SEED_POST_TRADE_RAPV", "1")
    return env


def write_transcript(name: str, row: dict) -> Path:
    (SUITE / "logs").mkdir(exist_ok=True)
    path = SUITE / "logs" / f"{name}.txt"
    path.write_text(
        f"# {name}\n# session={row.get('session')}\n# exit={row.get('exit_code')} seconds={row.get('seconds')}\n"
        f"# token_markers={row.get('token_markers')}\n\n"
        f"{row.get('stdout', '')}\n--- stderr ---\n{row.get('stderr', '')}\n"
    )
    return path


def run_eval(plugin: Path, env: dict[str, str]) -> dict:
    spec = load_spec()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    session = f"adherence-eval-{stamp}"
    results = []

    action = next(p for p in spec["probes"] if p.get("action_turn") and p["id"] == 6)
    row = run_prompt(plugin, action["prompt"], f"{session}-4a1", env)
    write_transcript("4a1-first-tool-call", row)
    ok, detail = check_first_output_is_tool_call(row["stdout"])
    results.append({"id": "4a-1", "ok": ok, "detail": detail, "prompt": action["prompt"]})

    digits = next(p for p in spec["probes"] if p.get("check_foreign_digits"))
    row = run_prompt(plugin, digits["prompt"], f"{session}-4a2", env)
    write_transcript("4a2-no-foreign-digits", row)
    ok, detail = check_no_foreign_digits(row["stdout"])
    results.append({"id": "4a-2", "ok": ok, "detail": detail, "prompt": digits["prompt"]})

    tik = maybe_tiktoken_check()
    if tik is not None:
        results.append({"id": "turn-contract-tokens", "ok": tik["ok"], "detail": tik})

    return {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "session": session,
        "passed": sum(1 for r in results if r["ok"]),
        "failed": sum(1 for r in results if not r["ok"]),
        "results": results,
    }


def golden_ok(probe: dict, stdout: str, spec: dict) -> tuple[bool, str]:
    key = probe.get("golden")
    if not key:
        return True, "no golden"
    needles = spec["goldens"][key]
    message = final_message(stdout) or stdout
    if key == "G3":
        if any(n in message for n in needles):
            return True, "G3 tell-only or already-true"
        return False, "G3 missing tell-only and already-true copy"
    missing = [n for n in needles if n not in message]
    if missing:
        return False, f"{key} missing {missing}"
    return True, key


def run_probes(plugin: Path, env: dict[str, str], long_session: bool) -> dict:
    spec = load_spec()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    mode = "long" if long_session else "fresh"
    base_session = f"adherence-{mode}-{stamp}"
    results = []
    fillers_used = 0

    if long_session:
        for i, filler in enumerate(spec["fillers"]):
            run_prompt(plugin, filler, base_session, env, max_turns="8")
            fillers_used += 1
        while fillers_used + len(spec["probes"]) < 20:
            run_prompt(plugin, spec["fillers"][fillers_used % len(spec["fillers"])], base_session, env, max_turns="8")
            fillers_used += 1

    for probe in spec["probes"]:
        session = base_session if long_session else f"{base_session}-p{probe['id']:02d}"
        row = run_prompt(plugin, probe["prompt"], session, env)
        write_transcript(f"{mode}-{probe['id']:02d}-{probe['name']}", row)
        checks = {}
        if probe.get("action_turn"):
            ok, detail = check_first_output_is_tool_call(row["stdout"])
            checks["first_tool_call"] = {"ok": ok, "detail": detail}
        if probe.get("check_foreign_digits"):
            ok, detail = check_no_foreign_digits(row["stdout"])
            checks["no_foreign_digits"] = {"ok": ok, "detail": detail}
        g_ok, g_detail = golden_ok(probe, row["stdout"], spec)
        checks["golden"] = {"ok": g_ok, "detail": g_detail}
        ok = all(v["ok"] for v in checks.values()) if checks else row["exit_code"] == 0
        results.append(
            {
                "id": probe["id"],
                "name": probe["name"],
                "prompt": probe["prompt"],
                "ok": ok,
                "exit_code": row["exit_code"],
                "seconds": row["seconds"],
                "token_markers": row["token_markers"],
                "checks": checks,
                "reply_tail": (final_message(row["stdout"]) or row["stdout"])[-600:],
            }
        )

    return {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "mode": mode,
        "session": base_session,
        "fillers": fillers_used,
        "turns": fillers_used + len(spec["probes"]),
        "passed": sum(1 for r in results if r["ok"]),
        "failed": sum(1 for r in results if not r["ok"]),
        "results": results,
        "note": (
            "Round 2 tests the static-recency variant (turn-contract.md last in COMPOSED). "
            "If probes 6/9 still narrate, that is evidence for the stage-2 injection ticket, "
            "not a reason to reopen the .md payload."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["eval", "probes", "all"])
    parser.add_argument("--long", action="store_true", help="single ≥20-turn session (probes only)")
    args = parser.parse_args()
    require_stack()
    plugin = plugin_path()
    env = env_for_eval()
    (SUITE / "logs").mkdir(exist_ok=True)
    outputs = {}
    if args.command in ("eval", "all"):
        outputs["eval"] = run_eval(plugin, env)
        print(json.dumps(outputs["eval"], indent=2))
    if args.command in ("probes", "all"):
        outputs["probes"] = run_probes(plugin, env, long_session=args.long)
        print(json.dumps(outputs["probes"], indent=2))
        if args.command == "all" and not args.long:
            outputs["probes_long"] = run_probes(plugin, env, long_session=True)
            print(json.dumps(outputs["probes_long"], indent=2))
    (SUITE / "results.json").write_text(json.dumps(outputs, indent=2) + "\n")
    failed = sum(block.get("failed", 0) for block in outputs.values())
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

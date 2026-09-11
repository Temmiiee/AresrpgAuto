"""Ported from AresRPGBot's packages/bot/src/policy_store.ts -- JSON persistence for a trained Policy."""
import json
from dataclasses import asdict
from pathlib import Path
from .policy import Policy

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "models" / "policy.json"

def save_trained_policy(policy, path=DEFAULT_PATH, **meta):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"policy": asdict(policy), **meta}, indent=2))

def load_trained_policy(path=DEFAULT_PATH):
    data = json.loads(Path(path).read_text())
    return Policy(**data["policy"])

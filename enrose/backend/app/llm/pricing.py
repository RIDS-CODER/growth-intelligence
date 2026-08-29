"""Token pricing, so every AI call carries a real USD figure.

Rates are USD per million tokens and are configuration, not truth — verify against
current Anthropic pricing before relying on the numbers for billing. An unknown
model falls back to the balanced rate rather than silently costing zero, because a
zero would make a misconfigured model look free.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Rate:
    input_per_mtok: float
    output_per_mtok: float
    cache_read_per_mtok: float


DEFAULT_RATES: dict[str, Rate] = {
    "claude-opus-5": Rate(15.0, 75.0, 1.5),
    "claude-sonnet-5": Rate(3.0, 15.0, 0.3),
    "claude-haiku-4-5-20251001": Rate(1.0, 5.0, 0.1),
}

_FALLBACK = DEFAULT_RATES["claude-sonnet-5"]


def rate_for(model: str) -> Rate:
    if model in DEFAULT_RATES:
        return DEFAULT_RATES[model]
    # Prefix match so dated snapshots of a known family price correctly.
    for known, rate in DEFAULT_RATES.items():
        if model.startswith(known.split("-2")[0]):
            return rate
    return _FALLBACK


def cost_usd(model: str, input_tokens: int, output_tokens: int, cache_read_tokens: int = 0) -> float:
    r = rate_for(model)
    total = (
        input_tokens * r.input_per_mtok
        + output_tokens * r.output_per_mtok
        + cache_read_tokens * r.cache_read_per_mtok
    ) / 1_000_000
    return round(total, 6)

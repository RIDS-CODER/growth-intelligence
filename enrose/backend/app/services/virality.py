"""Virality roll-up.

The model supplies twelve sub-scores with reasoning; this module turns them into
viral / business / overall numbers. Keeping the arithmetic here rather than in the
prompt is what makes scores comparable over time: a 78 in March means the same
thing as a 78 in September, because the same function produced both.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.schemas.ai import ViralityAssessment

# Dimensions that predict distribution.
VIRAL_WEIGHTS: dict[str, float] = {
    "hook_strength": 0.22,
    "curiosity": 0.13,
    "emotional_response": 0.12,
    "shareability": 0.13,
    "saveability": 0.15,
    "rewatch_potential": 0.10,
    "relatability": 0.08,
    "trend_alignment": 0.07,
}

# Dimensions that predict business outcome. Deliberately separate: a salon that
# collapses these into one number ends up optimising for views it cannot bank.
BUSINESS_WEIGHTS: dict[str, float] = {
    "audience_relevance": 0.30,
    "brand_fit": 0.25,
    "conversion_potential": 0.30,
    "visual_transformation": 0.15,
}

# Blend for the headline number. Configurable per client in a later phase.
VIRAL_SHARE = 0.5


@dataclass
class ViralityScores:
    viral_score: float
    business_score: float
    overall_score: float
    breakdown: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "viral_score": self.viral_score,
            "business_score": self.business_score,
            "overall_score": self.overall_score,
            "breakdown": self.breakdown,
        }


def _weighted(values: dict[str, float], weights: dict[str, float]) -> float:
    total_weight = sum(weights.values())
    if total_weight == 0:
        return 0.0
    return sum(values.get(k, 0.0) * w for k, w in weights.items()) / total_weight


def roll_up(assessment: ViralityAssessment) -> ViralityScores:
    """Turn model sub-scores into the three headline numbers."""
    dumped = assessment.model_dump()
    values: dict[str, float] = {}
    reasons: dict[str, str] = {}
    for key in (*VIRAL_WEIGHTS, *BUSINESS_WEIGHTS):
        dimension = dumped.get(key) or {}
        values[key] = float(dimension.get("score", 0.0))
        reasons[key] = dimension.get("reason", "")

    viral = round(_weighted(values, VIRAL_WEIGHTS), 1)
    business = round(_weighted(values, BUSINESS_WEIGHTS), 1)
    overall = round(viral * VIRAL_SHARE + business * (1 - VIRAL_SHARE), 1)

    return ViralityScores(
        viral_score=viral,
        business_score=business,
        overall_score=overall,
        breakdown={
            "dimensions": {k: {"score": values[k], "reason": reasons[k]} for k in values},
            "viral_weights": VIRAL_WEIGHTS,
            "business_weights": BUSINESS_WEIGHTS,
            "predicted_top_percentile": assessment.predicted_top_percentile,
            "biggest_weakness": assessment.biggest_weakness,
            "concrete_fix": assessment.concrete_fix,
            "explanation": assessment.explanation,
        },
    )


# A draft scoring below this is not worth a human's review time.
MIN_PUBLISHABLE_OVERALL = 55.0


def meets_quality_bar(scores: ViralityScores) -> tuple[bool, str | None]:
    if scores.overall_score < MIN_PUBLISHABLE_OVERALL:
        return False, (
            f"Overall score {scores.overall_score} is below the quality bar of "
            f"{MIN_PUBLISHABLE_OVERALL}. {scores.breakdown.get('concrete_fix', '')}".strip()
        )
    return True, None

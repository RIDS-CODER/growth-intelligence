"""AI output validation.

The contract this suite defends: application logic never sees unvalidated model
output. Every agent's fixture must satisfy its schema, malformed output must fail
loudly rather than being coerced, and a repair retry must actually repair.
"""

from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError

from app.agents import AGENTS
from app.agents.base import Agent, AgentContext, AgentError
from app.config import ModelTier
from app.llm.provider import LLMError, LLMResponse, MockProvider
from app.schemas.ai import ReelDraft, ViralityAssessment


@pytest.mark.parametrize("agent_name", sorted(AGENTS))
def test_every_agent_produces_schema_valid_output(agent_name, mock_provider):
    """A mock fixture that drifts from its schema must fail the build, not runtime."""
    agent = AGENTS[agent_name](provider=mock_provider)
    result = agent.run(AgentContext(client_id=uuid.uuid4(), brand_block="BRAND", memory_block=""))
    assert isinstance(result.output, agent.output_model)
    assert result.provider == "mock"


@pytest.mark.parametrize("agent_name", sorted(AGENTS))
def test_every_agent_declares_a_tier_and_tool_name(agent_name):
    agent_cls = AGENTS[agent_name]
    assert isinstance(agent_cls.tier, ModelTier)
    assert agent_cls.tool_name and agent_cls.tool_name != "result"
    assert agent_cls.system.strip(), f"{agent_name} has no system prompt"


def test_reel_draft_rejects_out_of_range_scores():
    with pytest.raises(ValidationError):
        ViralityAssessment.model_validate(
            {
                **{
                    key: {"score": 50, "reason": "x"}
                    for key in ViralityAssessment.model_fields
                    if key not in ("predicted_top_percentile", "biggest_weakness", "concrete_fix", "explanation")
                },
                "hook_strength": {"score": 150, "reason": "out of range"},
                "predicted_top_percentile": 50,
                "biggest_weakness": "x",
                "concrete_fix": "x",
                "explanation": "x",
            }
        )


def test_reel_draft_rejects_unknown_fields():
    """extra='forbid' means a model inventing a field is a visible failure."""
    with pytest.raises(ValidationError):
        ReelDraft.model_validate({"title": "x", "unexpected_field": "boom"})


def test_reel_draft_requires_minimum_shots():
    """A one-shot 'reel' is not a production package."""
    with pytest.raises(ValidationError) as exc:
        ReelDraft.model_validate(
            {
                "title": "t", "concept": "c", "pillar": "transformation", "objective": "reach",
                "hook": "h", "first_three_seconds": "f", "script": "s",
                "shots": [{"index": 1, "duration_s": 2, "description": "d", "camera": "c"}],
                "cta": "cta", "caption": "cap", "cover_text": "cov", "estimated_duration_s": 15,
            }
        )
    assert "shots" in str(exc.value)


class _BrokenProvider:
    """Always returns output that violates the schema."""

    name = "broken"

    def __init__(self) -> None:
        self.calls = 0

    def complete_structured(self, **kwargs) -> LLMResponse:
        self.calls += 1
        return LLMResponse(data={"nonsense": True}, model="m", provider=self.name)


class _RepairingProvider:
    """Fails once, then returns valid output — exercises the repair retry."""

    name = "repairing"

    def __init__(self) -> None:
        self.calls = 0

    def complete_structured(self, **kwargs) -> LLMResponse:
        self.calls += 1
        if self.calls == 1:
            return LLMResponse(data={"bad": "shape"}, model="m", provider=self.name)
        from app.llm.mock_fixtures import FIXTURES

        return LLMResponse(
            data=FIXTURES["virality_assessment"]("prompt"), model="m", provider=self.name
        )


def _scorer(provider):
    return AGENTS["virality_scorer"](provider=provider)


def test_invalid_output_raises_rather_than_coercing():
    """Malformed output must never be silently written to the database."""
    provider = _BrokenProvider()
    with pytest.raises(AgentError) as exc:
        _scorer(provider).run(AgentContext(client_id=uuid.uuid4()))
    assert "validation" in str(exc.value).lower()
    # One initial attempt plus the configured repair retry.
    assert provider.calls == 2


def test_repair_retry_recovers_from_one_bad_response():
    provider = _RepairingProvider()
    result = _scorer(provider).run(AgentContext(client_id=uuid.uuid4()))
    assert isinstance(result.output, ViralityAssessment)
    assert result.retries == 1
    assert provider.calls == 2


class _FailingProvider:
    name = "failing"

    def complete_structured(self, **kwargs) -> LLMResponse:
        raise LLMError("upstream is down")


def test_transport_failure_surfaces_as_agent_error():
    with pytest.raises(AgentError) as exc:
        _scorer(_FailingProvider()).run(AgentContext(client_id=uuid.uuid4()))
    assert "upstream is down" in str(exc.value)


def test_mock_provider_rejects_unknown_tool():
    """A new agent without a fixture must fail loudly, so it cannot ship untested."""

    class Orphan(Agent):
        name = "orphan"
        tool_name = "no_such_fixture"
        output_model = ReelDraft

        def build_user_prompt(self, ctx):
            return "x"

    with pytest.raises(AgentError):
        Orphan(provider=MockProvider()).run(AgentContext(client_id=uuid.uuid4()))


def test_agent_activity_is_logged_with_cost(db, client_id):
    from app.models.ops import AIActivityLog

    agent = AGENTS["virality_scorer"](provider=MockProvider())
    agent.run(AgentContext(client_id=client_id, db=db))
    db.commit()

    logs = db.query(AIActivityLog).filter(AIActivityLog.client_id == client_id).all()
    assert len(logs) == 1
    assert logs[0].agent == "virality_scorer"
    assert logs[0].success is True
    assert logs[0].input_digest


def test_agent_failure_is_logged(db, client_id):
    from app.models.ops import AIActivityLog

    with pytest.raises(AgentError):
        AGENTS["virality_scorer"](provider=_BrokenProvider()).run(
            AgentContext(client_id=client_id, db=db)
        )
    db.commit()

    logs = db.query(AIActivityLog).filter(AIActivityLog.success.is_(False)).all()
    assert len(logs) == 1
    assert "validation" in (logs[0].error or "").lower()


def test_cost_accounting_is_nonzero_for_real_providers():
    from app.llm import pricing

    assert pricing.cost_usd("claude-opus-5", 1_000_000, 0) == 15.0
    assert pricing.cost_usd("claude-sonnet-5", 0, 1_000_000) == 15.0
    # An unknown model must not price at zero — that would hide a misconfiguration.
    assert pricing.cost_usd("some-unreleased-model", 1_000_000, 0) > 0

"""LLM providers.

Two implementations behind one interface:

* `AnthropicProvider` — real Claude, using forced tool use so the model returns a
  typed object rather than prose to be regex-parsed out of a message.
* `MockProvider`   — deterministic, schema-valid fixtures. Lets the entire product
  run and be tested with no key and no network, on the *same* code path.

The mock is always labelled `provider="mock"` in responses and logs. Nothing in the
system ever presents mock output as real.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.config import settings
from app.llm import pricing


class LLMError(RuntimeError):
    """Provider-level failure (transport, auth, refusal, malformed tool use)."""


@dataclass
class LLMResponse:
    data: dict[str, Any]
    model: str
    provider: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    raw_text: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def cost_usd(self) -> float:
        if self.provider == "mock":
            return 0.0
        return pricing.cost_usd(
            self.model, self.input_tokens, self.output_tokens, self.cache_read_tokens
        )


class LLMProvider(Protocol):
    name: str

    def complete_structured(
        self,
        *,
        model: str,
        system: str,
        user_prompt: str,
        schema: dict[str, Any],
        tool_name: str,
        max_tokens: int = 4096,
        temperature: float = 1.0,
        cacheable_prefix: str | None = None,
    ) -> LLMResponse: ...


class AnthropicProvider:
    """Real Claude via forced tool use."""

    name = "anthropic"

    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key or settings.anthropic_api_key
        if not self._api_key:
            raise LLMError("AnthropicProvider requires ANTHROPIC_API_KEY")
        self._client: Any = None

    def _client_or_create(self) -> Any:
        # Imported lazily so the package is not a hard import-time dependency for
        # mock-only runs and tests.
        if self._client is None:
            try:
                from anthropic import Anthropic
            except ImportError as exc:  # pragma: no cover
                raise LLMError("anthropic package is not installed") from exc
            self._client = Anthropic(api_key=self._api_key)
        return self._client

    def complete_structured(
        self,
        *,
        model: str,
        system: str,
        user_prompt: str,
        schema: dict[str, Any],
        tool_name: str,
        max_tokens: int = 4096,
        temperature: float = 1.0,
        cacheable_prefix: str | None = None,
    ) -> LLMResponse:
        client = self._client_or_create()

        # The brand brain block is large and stable across the many calls in a
        # generation batch, so it is emitted as a cacheable prefix.
        system_blocks: list[dict[str, Any]] = []
        if cacheable_prefix:
            system_blocks.append(
                {
                    "type": "text",
                    "text": cacheable_prefix,
                    "cache_control": {"type": "ephemeral"},
                }
            )
        system_blocks.append({"type": "text", "text": system})

        tool = {
            "name": tool_name,
            "description": f"Return the {tool_name} result. Every field is required unless nullable.",
            "input_schema": schema,
        }

        try:
            message = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                temperature=temperature,
                system=system_blocks,
                tools=[tool],
                # Forcing the tool is what guarantees a typed object comes back.
                tool_choice={"type": "tool", "name": tool_name},
                messages=[{"role": "user", "content": user_prompt}],
            )
        except Exception as exc:  # noqa: BLE001 - surface any SDK/transport failure uniformly
            raise LLMError(f"Anthropic request failed: {exc}") from exc

        payload: dict[str, Any] | None = None
        for block in message.content:
            if getattr(block, "type", None) == "tool_use" and getattr(block, "name", "") == tool_name:
                payload = dict(block.input)
                break

        if payload is None:
            raise LLMError(f"Model returned no '{tool_name}' tool use block")

        usage = getattr(message, "usage", None)
        return LLMResponse(
            data=payload,
            model=model,
            provider=self.name,
            input_tokens=getattr(usage, "input_tokens", 0) or 0,
            output_tokens=getattr(usage, "output_tokens", 0) or 0,
            cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
            raw_text=json.dumps(payload)[:2000],
            meta={"stop_reason": getattr(message, "stop_reason", None)},
        )


class MockProvider:
    """Deterministic, schema-valid responses for offline development and tests.

    It is not intelligent — it returns brand-aware fixtures. Its job is to let every
    code path (validation, scoring, QA, status transitions, persistence) be
    exercised without a key, so tests prove the *system*, not the model.
    """

    name = "mock"

    def __init__(self, fixtures: dict[str, Any] | None = None) -> None:
        from app.llm import mock_fixtures

        self._fixtures = fixtures if fixtures is not None else mock_fixtures.FIXTURES

    def complete_structured(
        self,
        *,
        model: str,
        system: str,
        user_prompt: str,
        schema: dict[str, Any],
        tool_name: str,
        max_tokens: int = 4096,
        temperature: float = 1.0,
        cacheable_prefix: str | None = None,
    ) -> LLMResponse:
        builder = self._fixtures.get(tool_name)
        if builder is None:
            raise LLMError(
                f"MockProvider has no fixture for '{tool_name}'. "
                "Add one in app/llm/mock_fixtures.py so this agent is testable offline."
            )
        data = builder(user_prompt) if callable(builder) else builder
        return LLMResponse(
            data=json.loads(json.dumps(data)),  # deep copy; callers may mutate
            model=model,
            provider=self.name,
            input_tokens=len(user_prompt) // 4,
            output_tokens=200,
        )


def get_provider() -> LLMProvider:
    """Pick a provider from configuration.

    Absent credentials degrade to the mock rather than raising, so the product is
    always runnable; the caller records which provider ran.
    """
    if settings.ai_live:
        return AnthropicProvider()
    return MockProvider()

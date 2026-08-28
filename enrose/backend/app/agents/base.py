"""The agent runtime.

Every agent is a thin subclass: a name, an output schema, a model tier, a system
prompt and a user-prompt builder. Everything else — schema derivation, forced tool
use, validation, the repair retry, cost accounting and activity logging — happens
here once, identically, for all of them.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, ClassVar, Generic, TypeVar

from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.config import ModelTier, settings
from app.llm.provider import LLMError, LLMProvider, get_provider
from app.models.ops import AIActivityLog

T = TypeVar("T", bound=BaseModel)


class AgentError(RuntimeError):
    """Raised when an agent cannot produce a valid result.

    Deliberately loud: the alternative is coercing malformed output into the
    database, which is how a content engine starts publishing nonsense.
    """


@dataclass
class AgentContext:
    """Everything an agent may read, plus where to log what it did."""

    client_id: uuid.UUID
    db: Session | None = None
    brand_block: str = ""
    memory_block: str = ""
    extra: dict[str, Any] = field(default_factory=dict)
    content_item_id: uuid.UUID | None = None


@dataclass
class AgentResult(Generic[T]):
    output: T
    model: str
    provider: str
    cost_usd: float
    duration_ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    retries: int = 0

    @property
    def is_mock(self) -> bool:
        return self.provider == "mock"


def _strip_unsupported(schema: dict[str, Any]) -> dict[str, Any]:
    """Normalise Pydantic's JSON Schema for tool use.

    Pydantic emits `$defs`/`$ref` for nested models, which the tool-use schema
    validator accepts, but it also emits keys (`title`, `default`) that add noise
    without constraining anything. Dropping them keeps the schema compact, which
    matters because it is sent on every single call.
    """
    if not isinstance(schema, dict):
        return schema
    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key in ("title", "default"):
            continue
        if isinstance(value, dict):
            out[key] = _strip_unsupported(value)
        elif isinstance(value, list):
            out[key] = [_strip_unsupported(v) if isinstance(v, dict) else v for v in value]
        else:
            out[key] = value
    return out


class Agent(Generic[T]):
    """Base class for every AI agent."""

    name: ClassVar[str] = "agent"
    tool_name: ClassVar[str] = "result"
    task: ClassVar[str] = "generate"
    tier: ClassVar[ModelTier] = ModelTier.BALANCED
    output_model: ClassVar[type[BaseModel]]
    system: ClassVar[str] = ""
    max_tokens: ClassVar[int] = 4096
    temperature: ClassVar[float] = 1.0

    def __init__(self, provider: LLMProvider | None = None) -> None:
        self.provider = provider or get_provider()

    # ── Subclass responsibility ─────────────────────────────────────────────

    def build_user_prompt(self, ctx: AgentContext) -> str:
        raise NotImplementedError

    def build_system_prompt(self, ctx: AgentContext) -> str:
        return self.system

    # ── Runtime ─────────────────────────────────────────────────────────────

    def run(self, ctx: AgentContext) -> AgentResult[T]:
        schema = _strip_unsupported(self.output_model.model_json_schema())
        user_prompt = self.build_user_prompt(ctx)
        system_prompt = self.build_system_prompt(ctx)
        model = settings.model_for(self.tier)

        # The brand block is large and stable across a batch, so it is the cache prefix.
        cacheable_prefix = ctx.brand_block or None

        started = time.perf_counter()
        attempt = 0
        last_error: str | None = None
        prompt_for_call = user_prompt

        while attempt <= settings.ai_max_retries:
            try:
                response = self.provider.complete_structured(
                    model=model,
                    system=system_prompt,
                    user_prompt=prompt_for_call,
                    schema=schema,
                    tool_name=self.tool_name,
                    max_tokens=self.max_tokens,
                    temperature=self.temperature,
                    cacheable_prefix=cacheable_prefix,
                )
                validated = self.output_model.model_validate(response.data)
            except ValidationError as exc:
                last_error = f"schema validation failed: {exc.errors()[:5]}"
                attempt += 1
                if attempt > settings.ai_max_retries:
                    break
                # Feed the errors back so the retry is a repair, not a coin flip.
                prompt_for_call = (
                    f"{user_prompt}\n\n"
                    "Your previous response failed schema validation with these errors:\n"
                    f"{json.dumps(exc.errors()[:8], default=str, indent=2)}\n"
                    "Return a corrected object that satisfies the schema exactly."
                )
                continue
            except LLMError as exc:
                last_error = str(exc)
                attempt += 1
                if attempt > settings.ai_max_retries:
                    break
                continue

            duration_ms = int((time.perf_counter() - started) * 1000)
            result: AgentResult[T] = AgentResult(
                output=validated,  # type: ignore[arg-type]
                model=response.model,
                provider=response.provider,
                cost_usd=response.cost_usd,
                duration_ms=duration_ms,
                input_tokens=response.input_tokens,
                output_tokens=response.output_tokens,
                retries=attempt,
            )
            self._log(ctx, result, user_prompt, validated.model_dump(mode="json"), None)
            return result

        duration_ms = int((time.perf_counter() - started) * 1000)
        self._log_failure(ctx, model, user_prompt, last_error or "unknown error", duration_ms, attempt)
        raise AgentError(f"[{self.name}] failed after {attempt} attempt(s): {last_error}")

    # ── Observability ───────────────────────────────────────────────────────

    def _digest(self, prompt: str) -> str:
        return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:32]

    def _log(
        self,
        ctx: AgentContext,
        result: AgentResult[T],
        prompt: str,
        output: dict[str, Any],
        error: str | None,
    ) -> None:
        if ctx.db is None:
            return
        ctx.db.add(
            AIActivityLog(
                client_id=ctx.client_id,
                agent=self.name,
                task=self.task,
                input_digest=self._digest(prompt),
                input_summary=prompt[:500],
                output=output,
                model=result.model,
                provider=result.provider,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                cost_usd=result.cost_usd,
                duration_ms=result.duration_ms,
                success=error is None,
                error=error,
                retries=result.retries,
                content_item_id=ctx.content_item_id,
            )
        )
        ctx.db.flush()

    def _log_failure(
        self, ctx: AgentContext, model: str, prompt: str, error: str, duration_ms: int, retries: int
    ) -> None:
        if ctx.db is None:
            return
        ctx.db.add(
            AIActivityLog(
                client_id=ctx.client_id,
                agent=self.name,
                task=self.task,
                input_digest=self._digest(prompt),
                input_summary=prompt[:500],
                output={},
                model=model,
                provider=getattr(self.provider, "name", "unknown"),
                duration_ms=duration_ms,
                success=False,
                error=error[:2000],
                retries=retries,
                content_item_id=ctx.content_item_id,
            )
        )
        ctx.db.flush()

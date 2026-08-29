"""Application settings.

Every external dependency is optional. When credentials are absent the matching
subsystem degrades to a clearly-labelled mock rather than failing at import time,
so the whole product is runnable end to end with an unedited `.env.example`.
"""

from __future__ import annotations

from enum import Enum
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class ModelTier(str, Enum):
    """Which class of model an agent needs.

    Tiering is the primary cost lever: strategy and analysis get the strong model,
    bounded writing tasks get the cheap one. Agents declare a tier; they never
    name a model directly.
    """

    STRONG = "strong"
    BALANCED = "balanced"
    CHEAP = "cheap"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    app_env: str = "development"
    log_level: str = "INFO"
    secret_key: str = "dev-only-change-me-in-production"
    api_base_url: str = "http://localhost:8000"
    frontend_origins: str = "http://localhost:3000"

    database_url: str = "sqlite:///./enrose.db"

    anthropic_api_key: str = ""
    model_strong: str = "claude-opus-5"
    model_balanced: str = "claude-sonnet-5"
    model_cheap: str = "claude-haiku-4-5-20251001"
    ai_max_retries: int = 1
    ai_daily_cost_cap_usd: float = 25.0

    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 720
    next_public_supabase_url: str = ""
    supabase_service_role_key: str = ""
    supabase_jwt_secret: str = ""

    storage_provider: str = "local"
    storage_bucket: str = ""
    storage_region: str = "auto"
    storage_endpoint_url: str = ""
    storage_access_key_id: str = ""
    storage_secret_access_key: str = ""
    storage_public_base_url: str = ""
    storage_local_dir: str = "./var/uploads"

    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_access_token: str = ""
    meta_graph_version: str = "v21.0"
    meta_redirect_uri: str = "http://localhost:8000/api/v1/social/instagram/callback"

    scheduler_enabled: bool = False
    scheduler_tick_seconds: int = 60

    # ── Derived capability flags ────────────────────────────────────────────
    # Read these instead of testing credential strings at call sites.

    @property
    def ai_live(self) -> bool:
        return bool(self.anthropic_api_key.strip())

    @property
    def instagram_live(self) -> bool:
        return bool(self.meta_app_id.strip() and self.meta_app_secret.strip())

    @property
    def storage_live(self) -> bool:
        return self.storage_provider.lower() == "s3" and bool(self.storage_bucket.strip())

    @property
    def supabase_live(self) -> bool:
        return bool(self.supabase_jwt_secret.strip())

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.frontend_origins.split(",") if o.strip()]

    def model_for(self, tier: ModelTier) -> str:
        return {
            ModelTier.STRONG: self.model_strong,
            ModelTier.BALANCED: self.model_balanced,
            ModelTier.CHEAP: self.model_cheap,
        }[tier]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

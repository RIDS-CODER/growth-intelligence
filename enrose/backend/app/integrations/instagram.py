"""Instagram publishing.

Two implementations behind one interface:

* `InstagramGraphAPI` — the official Meta Graph API container→publish flow. Written
  against the real endpoints; it needs a Meta app, a Business/Creator account and
  app review for `instagram_content_publish`.
* `InstagramMock`    — returns clearly-labelled mock ids so the whole pipeline
  (scheduling, retries, status transitions, analytics ingest) is exercisable now.

There is deliberately no browser-automation path. Scraping or driving a logged-in
session would violate Instagram's terms and would break the moment the DOM changes.
When the API cannot do something, the honest answer is that it cannot be done yet.
"""

from __future__ import annotations

import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx

from app.config import settings


class PublishError(RuntimeError):
    """Publishing failed. `retryable` tells the worker whether to try again."""

    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass
class PublishRequest:
    caption: str
    media_url: str | None = None
    media_type: str = "REELS"  # REELS | IMAGE | CAROUSEL | STORIES
    children_urls: list[str] = field(default_factory=list)
    thumb_offset_ms: int | None = None
    share_to_feed: bool = True


@dataclass
class PublishResult:
    platform_post_id: str
    permalink: str | None
    provider: str
    published_at: datetime
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_mock(self) -> bool:
        return self.provider == "mock"


@dataclass
class MetricsResult:
    metrics: dict[str, float]
    provider: str
    captured_at: datetime


class InstagramClient(ABC):
    name: str

    @abstractmethod
    def publish(self, request: PublishRequest, *, ig_user_id: str, access_token: str) -> PublishResult: ...

    @abstractmethod
    def fetch_metrics(self, platform_post_id: str, *, access_token: str) -> MetricsResult: ...


class InstagramGraphAPI(InstagramClient):
    """Official Meta Graph API client.

    Publishing is a two-step flow: create a media container, wait for Instagram to
    finish processing it (video is asynchronous), then publish the container.
    """

    name = "graph_api"

    def __init__(self, timeout: float = 30.0) -> None:
        self.base = f"https://graph.facebook.com/{settings.meta_graph_version}"
        self.timeout = timeout

    def _post(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            response = httpx.post(f"{self.base}/{path}", data=params, timeout=self.timeout)
        except httpx.HTTPError as exc:
            raise PublishError(f"Network error calling Graph API: {exc}", retryable=True) from exc
        return self._handle(response)

    def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            response = httpx.get(f"{self.base}/{path}", params=params, timeout=self.timeout)
        except httpx.HTTPError as exc:
            raise PublishError(f"Network error calling Graph API: {exc}", retryable=True) from exc
        return self._handle(response)

    @staticmethod
    def _handle(response: httpx.Response) -> dict[str, Any]:
        if response.status_code >= 400:
            try:
                error = response.json().get("error", {})
            except ValueError:
                error = {"message": response.text[:300]}
            message = error.get("message", "unknown Graph API error")
            code = error.get("code")
            # 4xx other than rate limiting is a request problem: retrying it just
            # burns quota and hides the real fault.
            retryable = response.status_code >= 500 or code in (4, 17, 32, 613)
            raise PublishError(f"Graph API error ({response.status_code}, code {code}): {message}",
                               retryable=retryable)
        return response.json()

    def publish(self, request: PublishRequest, *, ig_user_id: str, access_token: str) -> PublishResult:
        if not request.media_url:
            raise PublishError("A media URL is required to publish to Instagram.", retryable=False)

        params: dict[str, Any] = {"access_token": access_token, "caption": request.caption}
        if request.media_type == "REELS":
            params.update({"media_type": "REELS", "video_url": request.media_url,
                           "share_to_feed": str(request.share_to_feed).lower()})
            if request.thumb_offset_ms is not None:
                params["thumb_offset"] = request.thumb_offset_ms
        elif request.media_type == "STORIES":
            params.update({"media_type": "STORIES", "video_url": request.media_url})
        else:
            params["image_url"] = request.media_url

        container = self._post(f"{ig_user_id}/media", params)
        container_id = container.get("id")
        if not container_id:
            raise PublishError(f"Graph API returned no container id: {container}", retryable=False)

        self._await_container(container_id, access_token)

        published = self._post(
            f"{ig_user_id}/media_publish",
            {"access_token": access_token, "creation_id": container_id},
        )
        post_id = published.get("id")
        if not post_id:
            raise PublishError(f"Graph API returned no post id: {published}", retryable=True)

        permalink = None
        try:
            permalink = self._get(post_id, {"access_token": access_token, "fields": "permalink"}).get(
                "permalink"
            )
        except PublishError:
            # The post exists; a missing permalink is cosmetic and must not fail the publish.
            pass

        return PublishResult(
            platform_post_id=str(post_id),
            permalink=permalink,
            provider=self.name,
            published_at=datetime.now(timezone.utc),
            raw=published,
        )

    def _await_container(
        self, container_id: str, access_token: str, *, max_wait_s: int = 300, interval_s: int = 5
    ) -> None:
        """Poll until Instagram finishes processing the upload."""
        deadline = time.monotonic() + max_wait_s
        while time.monotonic() < deadline:
            status = self._get(
                container_id, {"access_token": access_token, "fields": "status_code,status"}
            )
            code = status.get("status_code")
            if code == "FINISHED":
                return
            if code == "ERROR":
                raise PublishError(
                    f"Instagram rejected the media: {status.get('status', 'no detail')}",
                    retryable=False,
                )
            time.sleep(interval_s)
        raise PublishError("Timed out waiting for Instagram to process the media.", retryable=True)

    def fetch_metrics(self, platform_post_id: str, *, access_token: str) -> MetricsResult:
        metric_names = [
            "reach", "impressions", "likes", "comments", "shares", "saved",
            "total_interactions", "profile_visits", "follows",
        ]
        data = self._get(
            f"{platform_post_id}/insights",
            {"access_token": access_token, "metric": ",".join(metric_names)},
        )
        metrics: dict[str, float] = {}
        for entry in data.get("data", []):
            values = entry.get("values") or [{}]
            metrics[entry.get("name", "unknown")] = float(values[0].get("value", 0) or 0)
        return MetricsResult(metrics=metrics, provider=self.name, captured_at=datetime.now(timezone.utc))


class InstagramMock(InstagramClient):
    """MOCK publisher.

    Every id it returns is prefixed `mock_` and every result carries
    `provider="mock"`, so a mock publish can never be mistaken for a real one in the
    database, the API, or the UI.
    """

    name = "mock"

    def publish(self, request: PublishRequest, *, ig_user_id: str, access_token: str) -> PublishResult:
        if not request.caption:
            raise PublishError("A caption is required.", retryable=False)
        post_id = f"mock_{uuid.uuid4().hex[:16]}"
        return PublishResult(
            platform_post_id=post_id,
            permalink=f"https://www.instagram.com/p/{post_id}/",
            provider=self.name,
            published_at=datetime.now(timezone.utc),
            raw={
                "MOCK": True,
                "note": "Published by the MOCK Instagram client. No real post was created.",
                "media_type": request.media_type,
            },
        )

    def fetch_metrics(self, platform_post_id: str, *, access_token: str) -> MetricsResult:
        # Deterministic per post id, so repeated reads are stable and tests can assert.
        seed = int(platform_post_id[-6:], 36) if platform_post_id[-6:].isalnum() else 1234
        reach = 2000 + (seed % 9000)
        likes = int(reach * 0.06)
        return MetricsResult(
            metrics={
                "reach": float(reach),
                "impressions": float(int(reach * 1.35)),
                "views": float(int(reach * 1.1)),
                "likes": float(likes),
                "comments": float(max(1, likes // 12)),
                "shares": float(max(1, likes // 8)),
                "saved": float(max(1, likes // 4)),
                "profile_visits": float(max(1, reach // 60)),
                "follows": float(max(0, reach // 400)),
            },
            provider=self.name,
            captured_at=datetime.now(timezone.utc),
        )


def get_instagram_client() -> InstagramClient:
    if settings.instagram_live:
        return InstagramGraphAPI()
    return InstagramMock()

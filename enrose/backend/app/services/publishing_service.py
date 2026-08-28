"""Publishing worker logic: take due posts, publish them, record the outcome."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.enums import ActorType, ContentStatus, PublishStatus
from app.integrations.instagram import (
    InstagramClient,
    PublishError,
    PublishRequest,
    get_instagram_client,
)
from app.models.content import ContentAsset, ContentItem
from app.models.publishing import PublishedPost, ScheduledPost, SocialAccount
from app.services import content_status

MAX_ATTEMPTS = 3


def due_posts(db: Session, *, now: datetime | None = None, limit: int = 20) -> list[ScheduledPost]:
    now = now or datetime.now(timezone.utc)
    return list(
        db.execute(
            select(ScheduledPost)
            .where(
                ScheduledPost.status == PublishStatus.PENDING.value,
                ScheduledPost.publish_at <= now,
                ScheduledPost.attempts < MAX_ATTEMPTS,
            )
            .order_by(ScheduledPost.publish_at)
            .limit(limit)
        ).scalars().all()
    )


def _media_url_for(db: Session, item: ContentItem) -> str | None:
    """First attached asset, in position order, is the post's media."""
    from app.integrations.storage import get_storage

    link = db.execute(
        select(ContentAsset)
        .where(ContentAsset.content_item_id == item.id)
        .order_by(ContentAsset.position)
    ).scalars().first()
    if link is None:
        return None
    asset = link.asset
    if asset is None:
        return None
    return get_storage().url_for(asset.storage_key)


def publish_one(
    db: Session, post: ScheduledPost, *, client: InstagramClient | None = None
) -> PublishedPost:
    """Publish a single queued post, recording success or failure durably."""
    client = client or get_instagram_client()
    item = db.get(ContentItem, post.content_item_id)
    if item is None:
        post.status = PublishStatus.CANCELLED.value
        post.last_error = "Content item no longer exists."
        db.commit()
        raise PublishError("Content item no longer exists.", retryable=False)

    account = (
        db.get(SocialAccount, post.social_account_id) if post.social_account_id else None
    )

    post.status = PublishStatus.PUBLISHING.value
    post.attempts += 1
    db.flush()

    media_type = "REELS" if item.format == "reel" else "IMAGE"
    request = PublishRequest(
        caption=item.caption or item.title,
        media_url=_media_url_for(db, item),
        media_type=media_type,
    )

    try:
        result = client.publish(
            request,
            ig_user_id=(account.ig_user_id if account else "mock_ig_user"),
            access_token=(account.access_token if account else "mock_token"),
        )
    except PublishError as exc:
        post.last_error = str(exc)[:2000]
        # A retryable failure goes back on the queue; a permanent one stops.
        if exc.retryable and post.attempts < MAX_ATTEMPTS:
            post.status = PublishStatus.PENDING.value
        else:
            post.status = PublishStatus.FAILED.value
            content_status.transition(
                db, item, ContentStatus.PUBLISH_FAILED,
                actor_type=ActorType.SYSTEM, note=str(exc)[:500],
            )
        db.commit()
        raise

    published = PublishedPost(
        client_id=post.client_id,
        content_item_id=item.id,
        scheduled_post_id=post.id,
        platform="instagram",
        platform_post_id=result.platform_post_id,
        permalink=result.permalink,
        published_at=result.published_at,
        provider=result.provider,
        meta=result.raw,
    )
    db.add(published)

    post.status = PublishStatus.PUBLISHED.value
    post.last_error = None
    post.provider = result.provider
    item.published_at = result.published_at
    content_status.transition(
        db, item, ContentStatus.PUBLISHED, actor_type=ActorType.SYSTEM,
        note=f"Published via {result.provider}",
    )

    db.commit()
    db.refresh(published)
    return published


def run_due(db: Session, *, client: InstagramClient | None = None, limit: int = 20) -> dict[str, int]:
    """Worker tick: publish everything due. One failure must not stop the rest."""
    client = client or get_instagram_client()
    published = failed = 0
    for post in due_posts(db, limit=limit):
        try:
            publish_one(db, post, client=client)
            published += 1
        except PublishError:
            failed += 1
    return {"published": published, "failed": failed}


def connect_mock_account(db: Session, client_id: uuid.UUID, handle: str = "enrosesalon") -> SocialAccount:
    """Create the labelled mock connection used until real OAuth is configured."""
    existing = db.execute(
        select(SocialAccount).where(
            SocialAccount.client_id == client_id, SocialAccount.platform == "instagram"
        )
    ).scalars().first()
    if existing is not None:
        return existing

    account = SocialAccount(
        client_id=client_id,
        platform="instagram",
        handle=handle,
        ig_user_id="mock_ig_user",
        access_token=None,
        is_active=True,
        is_mock=True,
        meta={"MOCK": True, "note": "Not a real Instagram connection. Configure META_APP_ID to connect."},
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account

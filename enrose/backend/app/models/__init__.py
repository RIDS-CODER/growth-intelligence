"""Model package.

Importing this module registers every mapper, which is what `db.create_all()` and
Alembic autogenerate rely on.
"""

from app.models.analytics import AIInsight, AnalyticsSnapshot
from app.models.base import Base
from app.models.brand import (
    Audience,
    Brand,
    BrandAsset,
    BrandMemory,
    Competitor,
    ContentPillar,
    Product,
    Service,
)
from app.models.content import (
    Approval,
    Asset,
    CalendarEntry,
    Campaign,
    ContentAsset,
    ContentIdea,
    ContentItem,
    ContentMemory,
    ContentVariant,
    Strategy,
)
from app.models.engagement import Comment, DMThread, Lead
from app.models.ops import AIActivityLog, AuditLog
from app.models.publishing import PublishedPost, ScheduledPost, SocialAccount
from app.models.research import CompetitorPost, Trend
from app.models.tenancy import Client, Membership, User

__all__ = [
    "AIActivityLog",
    "AIInsight",
    "AnalyticsSnapshot",
    "Approval",
    "Asset",
    "Audience",
    "AuditLog",
    "Base",
    "Brand",
    "BrandAsset",
    "BrandMemory",
    "CalendarEntry",
    "Campaign",
    "Client",
    "Comment",
    "Competitor",
    "CompetitorPost",
    "ContentAsset",
    "ContentIdea",
    "ContentItem",
    "ContentMemory",
    "ContentPillar",
    "ContentVariant",
    "DMThread",
    "Lead",
    "Membership",
    "Product",
    "PublishedPost",
    "ScheduledPost",
    "Service",
    "SocialAccount",
    "Strategy",
    "Trend",
    "User",
]

"""Domain vocabulary.

Persisted as text so a `psql` session stays readable and adding a value is not a
migration hazard.
"""

from __future__ import annotations

from enum import Enum


class Confidence(str, Enum):
    """How much a stored brand fact can be trusted.

    `UNKNOWN` is a real, first-class value: it means "not established", and the
    prompt renderer emits it verbatim so a model is told what it may not assert.
    """

    VERIFIED = "verified"
    REPORTED = "reported"
    INFERRED = "inferred"
    UNKNOWN = "unknown"


class ContentFormat(str, Enum):
    REEL = "reel"
    CAROUSEL = "carousel"
    STATIC = "static"
    STORY = "story"


class ContentStatus(str, Enum):
    IDEA = "idea"
    DRAFT = "draft"
    AI_REVIEW = "ai_review"
    READY_FOR_APPROVAL = "ready_for_approval"
    REVISION_REQUESTED = "revision_requested"
    REJECTED = "rejected"
    CLIENT_APPROVED = "client_approved"
    SCHEDULED = "scheduled"
    PUBLISHED = "published"
    PUBLISH_FAILED = "publish_failed"
    ANALYZING = "analyzing"
    LEARNED = "learned"


class Objective(str, Enum):
    REACH = "reach"
    ENGAGEMENT = "engagement"
    SAVES = "saves"
    PROFILE_VISITS = "profile_visits"
    BOOKINGS = "bookings"
    AUTHORITY = "authority"
    COMMUNITY = "community"


class ApprovalLevel(str, Enum):
    """Level 2 is opt-in per client; eligibility is decided in services/approval.py."""

    L1_HUMAN_REQUIRED = "l1_human_required"
    L2_AUTO_LOW_RISK = "l2_auto_low_risk"
    L3_MANDATORY_HUMAN = "l3_mandatory_human"


class ApprovalDecision(str, Enum):
    APPROVED = "approved"
    REJECTED = "rejected"
    REVISION_REQUESTED = "revision_requested"


class AssetKind(str, Enum):
    VIDEO = "video"
    IMAGE = "image"
    AUDIO = "audio"
    DOCUMENT = "document"


class FootageType(str, Enum):
    """What a raw clip shows. Drives sequencing and the missing-shot report."""

    BEFORE = "before"
    WASH = "wash"
    CUT = "cut"
    COLOR = "color"
    TREATMENT = "treatment"
    STYLING = "styling"
    AFTER = "after"
    REACTION = "reaction"
    DETAIL = "detail"
    BTS = "bts"
    PRODUCT = "product"
    SALON = "salon"
    UNTAGGED = "untagged"


class PublishStatus(str, Enum):
    PENDING = "pending"
    PUBLISHING = "publishing"
    PUBLISHED = "published"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TrendStatus(str, Enum):
    DETECTED = "detected"
    ADOPTED = "adopted"
    REJECTED = "rejected"
    EXPIRED = "expired"


class LeadIntent(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    UNKNOWN = "unknown"


class CommentClass(str, Enum):
    POSITIVE = "positive"
    QUESTION = "question"
    PRICE_REQUEST = "price_request"
    BOOKING_INTENT = "booking_intent"
    COMPLAINT = "complaint"
    SPAM = "spam"
    NEGATIVE = "negative"
    NEEDS_HUMAN = "needs_human"


class ActorType(str, Enum):
    USER = "user"
    AGENT = "agent"
    SYSTEM = "system"

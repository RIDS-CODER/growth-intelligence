"""Content memory: the anti-repetition layer.

Stops the "5 hair mistakes" / "5 haircare mistakes" / "5 mistakes damaging your
hair" failure mode. Fingerprints are normalised token sets and comparison is
Jaccard similarity, so this is pure Python running *before* generation — it costs
nothing and it catches the near-duplicates a model would happily produce.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.content import ContentItem, ContentMemory

# Words that carry no topical signal; ignoring them is what makes
# "5 hair mistakes" and "mistakes with your hair" collide as intended.
_STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "for", "with",
    "your", "you", "our", "we", "is", "are", "was", "were", "be", "been", "this", "that",
    "these", "those", "it", "its", "at", "by", "from", "as", "how", "what", "why", "when",
    "do", "does", "did", "not", "no", "yes", "can", "will", "should", "must", "about",
    "top", "best", "most", "more", "less", "than", "then", "before", "after", "s",
}

_NUMBER = re.compile(r"^\d+$")

# Longest-first so "ations" is stripped before "s". Crude on purpose: a real stemmer
# would be heavier than this problem deserves, and over-stemming only makes the
# duplicate check slightly more cautious, which is the safe direction to err.
_SUFFIXES = ("ations", "ation", "ingly", "ing", "edly", "ies", "ied", "ers", "er", "ed", "ly", "es", "s")


def _stem(word: str) -> str:
    """Collapse morphological variants so 'damaging' and 'damage' compare equal.

    Without this, "5 hair mistakes damaging your hair" and "7 haircare mistakes that
    damage hair" score only 0.40 similarity and both get published — which is exactly
    the repetition this module exists to prevent.
    """
    for suffix in _SUFFIXES:
        if len(word) > len(suffix) + 3 and word.endswith(suffix):
            stem = word[: -len(suffix)]
            # "damage" -> "damag" and "damaging" -> "damag" only agree once the
            # trailing 'e' goes too.
            return stem.rstrip("e") or stem
    return word.rstrip("e") if len(word) > 4 else word


def fingerprint(text: str) -> str:
    """Normalise text to a sorted, deduplicated set of stemmed tokens.

    Numbers are dropped so "5 mistakes" and "7 mistakes" are recognised as the same
    idea wearing a different hat.
    """
    if not text:
        return ""
    words = re.findall(r"[a-z]+|\d+", text.lower())
    tokens = {
        _stem(w) for w in words if w not in _STOPWORDS and not _NUMBER.match(w) and len(w) > 2
    }
    return " ".join(sorted(tokens))


def similarity(a: str, b: str) -> float:
    """Jaccard similarity between two fingerprints."""
    set_a, set_b = set(a.split()), set(b.split())
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


# Above this, two topics are the same idea reworded.
DUPLICATE_THRESHOLD = 0.62


@dataclass
class DuplicateCheck:
    is_duplicate: bool
    similarity: float
    matched_topic: str | None = None
    matched_id: uuid.UUID | None = None

    @property
    def reason(self) -> str | None:
        if not self.is_duplicate:
            return None
        return (
            f"Too similar ({self.similarity:.0%}) to previously used topic: "
            f"'{self.matched_topic}'. Choose a genuinely different angle."
        )


def check_duplicate(
    db: Session, client_id: uuid.UUID, topic: str, *, threshold: float = DUPLICATE_THRESHOLD
) -> DuplicateCheck:
    """Compare a proposed topic against everything this client has already used."""
    probe = fingerprint(topic)
    if not probe:
        return DuplicateCheck(is_duplicate=False, similarity=0.0)

    rows = db.execute(
        select(ContentMemory).where(ContentMemory.client_id == client_id)
    ).scalars().all()

    best = DuplicateCheck(is_duplicate=False, similarity=0.0)
    for row in rows:
        score = similarity(probe, row.topic_fingerprint)
        if score > best.similarity:
            best = DuplicateCheck(
                is_duplicate=score >= threshold,
                similarity=score,
                matched_topic=row.topic,
                matched_id=row.id,
            )
    return best


def record(
    db: Session,
    client_id: uuid.UUID,
    *,
    topic: str,
    pillar: str,
    content_format: str,
    hook: str | None = None,
    content_item_id: uuid.UUID | None = None,
) -> ContentMemory:
    """Add a topic to memory so it is never quietly reused."""
    entry = ContentMemory(
        client_id=client_id,
        content_item_id=content_item_id,
        topic=topic,
        hook=hook,
        topic_fingerprint=fingerprint(topic),
        hook_fingerprint=fingerprint(hook or ""),
        pillar=pillar,
        format=content_format,
        outcome="unknown",
    )
    db.add(entry)
    db.flush()
    return entry


def recent_topics(db: Session, client_id: uuid.UUID, limit: int = 40) -> list[str]:
    """Recent topics, for injection into generation prompts."""
    rows = db.execute(
        select(ContentMemory.topic)
        .where(ContentMemory.client_id == client_id)
        .order_by(ContentMemory.created_at.desc())
        .limit(limit)
    ).scalars().all()
    return list(rows)


def update_outcomes(db: Session, client_id: uuid.UUID, performance: dict[uuid.UUID, float]) -> int:
    """Label memory entries with how their content actually performed.

    `performance` maps content_item_id to a performance index where 1.0 is the
    account average. Turning memory from "what we said" into "what worked" is what
    lets the strategist prefer winning angles rather than merely avoiding repeats.
    """
    if not performance:
        return 0
    rows = db.execute(
        select(ContentMemory).where(
            ContentMemory.client_id == client_id,
            ContentMemory.content_item_id.in_(list(performance.keys())),
        )
    ).scalars().all()
    for row in rows:
        index = performance.get(row.content_item_id)
        if index is None:
            continue
        row.performance_index = index
        row.outcome = "winner" if index >= 1.3 else ("poor" if index <= 0.7 else "average")
    db.flush()
    return len(rows)


def winning_topics(db: Session, client_id: uuid.UUID, limit: int = 10) -> list[dict]:
    rows = db.execute(
        select(ContentMemory)
        .where(ContentMemory.client_id == client_id, ContentMemory.outcome == "winner")
        .order_by(ContentMemory.performance_index.desc())
        .limit(limit)
    ).scalars().all()
    return [
        {"topic": r.topic, "pillar": r.pillar, "format": r.format, "index": r.performance_index}
        for r in rows
    ]


def link_published(db: Session, item: ContentItem) -> None:
    """Ensure a published item is represented in memory."""
    existing = db.execute(
        select(ContentMemory).where(ContentMemory.content_item_id == item.id)
    ).scalar_one_or_none()
    if existing is None:
        record(
            db,
            item.client_id,
            topic=item.title,
            pillar=item.pillar,
            content_format=item.format,
            hook=item.hook,
            content_item_id=item.id,
        )

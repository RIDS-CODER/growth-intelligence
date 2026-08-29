"""Calendar generation and rescheduling.

Slot allocation is deterministic arithmetic, not a model decision: given a posting
frequency and a pillar mix, the distribution of formats and pillars across dates is
computable, repeatable and testable. The model decides *what* to post; this decides
*when*.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.enums import ContentFormat
from app.models.brand import ContentPillar
from app.models.content import CalendarEntry, ContentIdea, ContentItem, Strategy

# Posting times chosen per format. Reels get evening slots (highest scroll volume),
# carousels get a late-morning slot where saving behaviour is stronger.
DEFAULT_SLOTS: dict[str, list[time]] = {
    ContentFormat.REEL.value: [time(19, 0), time(13, 0)],
    ContentFormat.CAROUSEL.value: [time(11, 0)],
    ContentFormat.STATIC.value: [time(17, 0)],
}

# Weekday preference: 0=Monday. Salons see the most booking intent Thu-Sat.
PREFERRED_DAYS: dict[str, list[int]] = {
    ContentFormat.REEL.value: [1, 3, 4, 5],
    ContentFormat.CAROUSEL.value: [0, 2],
    ContentFormat.STATIC.value: [6],
}


@dataclass
class CalendarPlan:
    entries: list[CalendarEntry]
    strategy_id: uuid.UUID | None
    counts: dict[str, int]


def _pillar_sequence(db: Session, client_id: uuid.UUID, mix: dict[str, float], n: int) -> list[str]:
    """Expand a weighted pillar mix into a concrete, interleaved sequence.

    Largest-remainder allocation gives exact counts, then the sequence is interleaved
    so the feed alternates pillars instead of posting four transformations in a row.
    """
    if not mix:
        rows = db.execute(
            select(ContentPillar).where(
                ContentPillar.client_id == client_id, ContentPillar.is_active.is_(True)
            )
        ).scalars().all()
        mix = {p.key: p.weight for p in rows} or {"transformation": 1.0}

    total = sum(mix.values()) or 1.0
    exact = {k: (v / total) * n for k, v in mix.items()}
    counts = {k: int(v) for k, v in exact.items()}
    remainder = n - sum(counts.values())
    for key, _ in sorted(exact.items(), key=lambda kv: kv[1] - int(kv[1]), reverse=True):
        if remainder <= 0:
            break
        counts[key] += 1
        remainder -= 1

    # Interleave: round-robin across pillars that still have budget.
    sequence: list[str] = []
    while len(sequence) < n:
        progressed = False
        for key in sorted(counts, key=lambda k: mix.get(k, 0), reverse=True):
            if counts[key] > 0:
                sequence.append(key)
                counts[key] -= 1
                progressed = True
                if len(sequence) >= n:
                    break
        if not progressed:
            break
    return sequence


def _dates_for_format(start: date, days: int, fmt: str, count: int) -> list[datetime]:
    """Spread `count` posts of one format across the window on preferred weekdays."""
    if count <= 0:
        return []
    preferred = PREFERRED_DAYS.get(fmt, list(range(7)))
    slots = DEFAULT_SLOTS.get(fmt, [time(18, 0)])

    candidates: list[datetime] = []
    for offset in range(days):
        day = start + timedelta(days=offset)
        if day.weekday() in preferred:
            for slot in slots:
                candidates.append(datetime.combine(day, slot, tzinfo=timezone.utc))
    if not candidates:
        for offset in range(days):
            candidates.append(
                datetime.combine(start + timedelta(days=offset), slots[0], tzinfo=timezone.utc)
            )

    candidates.sort()
    if len(candidates) <= count:
        return candidates[:count]

    # Evenly sample so posts are spread across the window rather than front-loaded.
    step = len(candidates) / count
    return [candidates[min(len(candidates) - 1, int(i * step))] for i in range(count)]


def generate_calendar(
    db: Session,
    client_id: uuid.UUID,
    *,
    start: date | None = None,
    days: int = 30,
    strategy: Strategy | None = None,
    replace_existing: bool = True,
) -> CalendarPlan:
    """Lay a strategy's format split into dated, pillar-assigned slots."""
    start = start or date.today()
    end = start + timedelta(days=days - 1)

    if strategy is None:
        strategy = db.execute(
            select(Strategy)
            .where(Strategy.client_id == client_id, Strategy.status == "active")
            .order_by(Strategy.created_at.desc())
        ).scalars().first()

    format_split = (strategy.format_split if strategy else None) or {
        ContentFormat.REEL.value: 16,
        ContentFormat.CAROUSEL.value: 8,
    }
    pillar_mix = (strategy.pillar_mix if strategy else None) or {}

    if replace_existing:
        window_start = datetime.combine(start, time.min, tzinfo=timezone.utc)
        window_end = datetime.combine(end, time.max, tzinfo=timezone.utc)
        stale = db.execute(
            select(CalendarEntry).where(
                CalendarEntry.client_id == client_id,
                CalendarEntry.scheduled_for >= window_start,
                CalendarEntry.scheduled_for <= window_end,
                CalendarEntry.status == "planned",
                # Never discard a slot that already has content attached.
                CalendarEntry.content_item_id.is_(None),
            )
        ).scalars().all()
        for row in stale:
            db.delete(row)
        db.flush()

    # Open ideas seed the topics so the calendar is specific, not just shaped.
    ideas = db.execute(
        select(ContentIdea)
        .where(ContentIdea.client_id == client_id, ContentIdea.status == "open")
        .order_by(ContentIdea.created_at.desc())
    ).scalars().all()
    ideas_by_format: dict[str, list[ContentIdea]] = {}
    for idea in ideas:
        ideas_by_format.setdefault(idea.format, []).append(idea)

    entries: list[CalendarEntry] = []
    counts: dict[str, int] = {}

    for fmt, count in format_split.items():
        if fmt == ContentFormat.STORY.value or count <= 0:
            continue  # stories are planned daily by the story engine, not slotted here
        when_list = _dates_for_format(start, days, fmt, int(count))
        pillars = _pillar_sequence(db, client_id, pillar_mix, len(when_list))
        pool = ideas_by_format.get(fmt, [])

        for i, when in enumerate(when_list):
            pillar = pillars[i] if i < len(pillars) else (pillars[0] if pillars else "transformation")
            # Prefer an idea matching this slot's pillar; fall back to any unused idea.
            topic = None
            match = next((idea for idea in pool if idea.pillar == pillar), None) or (
                pool[0] if pool else None
            )
            if match is not None:
                topic = match.title
                pool.remove(match)

            entry = CalendarEntry(
                client_id=client_id,
                strategy_id=strategy.id if strategy else None,
                scheduled_for=when,
                slot_label=when.strftime("%a %H:%M"),
                format=fmt,
                pillar=pillar,
                topic=topic,
                status="planned",
                position=i,
            )
            db.add(entry)
            entries.append(entry)
        counts[fmt] = len(when_list)

    db.commit()
    for entry in entries:
        db.refresh(entry)

    return CalendarPlan(
        entries=entries, strategy_id=strategy.id if strategy else None, counts=counts
    )


def reschedule(
    db: Session, client_id: uuid.UUID, entry_id: uuid.UUID, new_time: datetime
) -> CalendarEntry:
    """Move a calendar entry — the drag-and-drop operation."""
    entry = db.execute(
        select(CalendarEntry).where(
            CalendarEntry.id == entry_id, CalendarEntry.client_id == client_id
        )
    ).scalar_one_or_none()
    if entry is None:
        raise ValueError("Calendar entry not found")

    if new_time.tzinfo is None:
        new_time = new_time.replace(tzinfo=timezone.utc)

    entry.scheduled_for = new_time
    entry.slot_label = new_time.strftime("%a %H:%M")

    # Keep the attached content item's schedule in step.
    if entry.content_item_id:
        item = db.get(ContentItem, entry.content_item_id)
        if item is not None and item.scheduled_for is not None:
            item.scheduled_for = new_time

    db.commit()
    db.refresh(entry)
    return entry


def attach_content(
    db: Session, client_id: uuid.UUID, entry_id: uuid.UUID, content_item_id: uuid.UUID
) -> CalendarEntry:
    entry = db.execute(
        select(CalendarEntry).where(
            CalendarEntry.id == entry_id, CalendarEntry.client_id == client_id
        )
    ).scalar_one_or_none()
    if entry is None:
        raise ValueError("Calendar entry not found")
    item = db.execute(
        select(ContentItem).where(
            ContentItem.id == content_item_id, ContentItem.client_id == client_id
        )
    ).scalar_one_or_none()
    if item is None:
        raise ValueError("Content item not found")

    entry.content_item_id = item.id
    entry.topic = item.title
    entry.status = "assigned"
    item.scheduled_for = entry.scheduled_for
    db.commit()
    db.refresh(entry)
    return entry

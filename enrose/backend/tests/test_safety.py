"""Safety guardrails.

Fabrication is the biggest product risk for a real salon, so these tests are the
most important in the suite. The rule scanner must catch what a model would
plausibly invent, and it must not be overridable by the model's own opinion.
"""

from __future__ import annotations

import pytest

from app.services import safety

KNOWN_PRODUCTS = ["Kérastase", "Bioline", "Cuccio", "Blue Sky", "Redken", "L'Oréal Professionnel"]


@pytest.mark.parametrize(
    "text",
    [
        "Our balayage starts at ₹4,500 this month.",
        "Get your keratin treatment for Rs 3000.",
        "Facials from INR 1200.",
        "Book now for $99.",
        "Just 2500 rupees for a full colour.",
    ],
)
def test_currency_amounts_are_blocked(text):
    result = safety.scan_text(text)
    assert not result.passed
    assert any(f.rule == "invented_pricing" for f in result.blocking)


@pytest.mark.parametrize(
    "text",
    [
        "Enjoy 30% off all hair services!",
        "Flat 500 off this weekend.",
        "Buy one get one free on facials.",
        "Limited time offer — book today.",
        "Use promo code GLOW for a discount.",
    ],
)
def test_offers_and_discounts_are_blocked(text):
    result = safety.scan_text(text)
    assert not result.passed
    assert any(f.rule == "invented_offer" for f in result.blocking)


@pytest.mark.parametrize(
    "text",
    [
        "This treatment cures dandruff permanently.",
        "Clinically proven to reverse hair loss.",
        "Dermatologist approved for all skin types.",
        "Our facial treats acne at the root.",
        "Regrows hair in weeks.",
    ],
)
def test_medical_claims_are_blocked(text):
    result = safety.scan_text(text)
    assert not result.passed
    assert any(f.rule == "medical_claim" for f in result.blocking)


@pytest.mark.parametrize(
    "text",
    [
        "Guaranteed results or your money back.",
        "100% safe for coloured hair.",
        "Results in 7 days.",
        "Risk-free treatment.",
    ],
)
def test_guarantees_are_blocked(text):
    result = safety.scan_text(text)
    assert not result.passed
    assert any(f.rule == "guarantee_claim" for f in result.blocking)


@pytest.mark.parametrize(
    "text",
    [
        '"Best salon I have ever visited in Jamshedpur" - Priya',
        "Rated 4.9/5 by our clients.",
        "Our clients say we are the best.",
    ],
)
def test_fabricated_testimonials_are_blocked(text):
    result = safety.scan_text(text)
    assert not result.passed
    assert any(f.rule == "fabricated_testimonial" for f in result.blocking)


def test_unknown_product_brand_is_blocked():
    """The most likely fabrication for a beauty model: naming a brand not carried."""
    result = safety.scan_text(
        "We finish every service with Olaplex for lasting bond repair.",
        known_products=KNOWN_PRODUCTS,
    )
    assert not result.passed
    assert any(f.rule == "unknown_product_brand" for f in result.blocking)


def test_known_product_brands_are_permitted():
    result = safety.scan_text(
        "Our Hair Rituals by Kérastase are chosen after a consultation, and we colour with Redken.",
        known_products=KNOWN_PRODUCTS,
    )
    assert result.passed, [f.rule for f in result.blocking]


def test_superlatives_warn_but_do_not_block():
    """A superlative is a judgement call for a human, not an automatic rejection."""
    result = safety.scan_text("We are the best salon in town.")
    assert result.passed
    assert any(f.rule == "unverified_superlative" for f in result.findings)


def test_clean_brand_safe_copy_passes():
    result = safety.scan_text(
        "Your hair isn't damaged because you use heat. It's what happens before the heat. "
        "Our stylists will talk through your routine at your next consultation. Save this.",
        known_products=KNOWN_PRODUCTS,
    )
    assert result.passed
    assert not result.findings


def test_scan_walks_nested_payloads():
    """A price hidden in a shot list must be caught as surely as one in the caption."""
    payload = {
        "title": "Clean title",
        "caption": "Clean caption",
        "shots": [
            {"index": 1, "description": "Close-up", "on_screen_text": "Only ₹999 today!"},
        ],
    }
    result = safety.scan_content_item(payload, known_products=KNOWN_PRODUCTS)
    assert not result.passed
    assert any(f.rule == "invented_pricing" for f in result.blocking)


def test_seeded_brand_records_no_prices(db, seeded):
    """The Brand Brain must contain no price a model could copy."""
    from app.services import brand_service
    import uuid

    brand = brand_service.build_brand_dict(db, uuid.UUID(seeded["client_id"]))
    assert brand["services"]
    assert all(s["price"] is None for s in brand["services"])


def test_brand_block_states_unknowns_explicitly(db, seeded):
    """A missing field invites invention; a field labelled UNKNOWN forbids it."""
    import uuid

    from app.services import brand_service

    block = brand_service.build_brand_block(db, uuid.UUID(seeded["client_id"]))
    assert "price UNKNOWN" in block
    assert "You may NOT assert or invent them" in block
    assert "service_pricing" in block


def test_safety_preamble_reaches_every_content_agent():
    from app.agents import AGENTS
    from app.prompts.shared import SAFETY_PREAMBLE

    marker = "NEVER invent, imply, estimate"
    for name in ("reel_writer", "carousel_writer", "caption_writer", "qa_reviewer", "story_writer"):
        assert marker in AGENTS[name].system, f"{name} is missing the safety preamble"
    assert marker in SAFETY_PREAMBLE

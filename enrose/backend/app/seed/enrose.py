"""Seed the Enrose Salon Brand Brain.

Every fact here traces to `docs/BRAND_RESEARCH.md`. Nothing is invented.

The three rules this file obeys:

1. **No prices.** None are published anywhere, so every `price` is `None`, which the
   prompt renderer emits as "price UNKNOWN".
2. **No Instagram metrics.** The profile is unreachable from this environment, so
   follower count, cadence and historical performance are recorded in
   `unknown_fields`, not guessed.
3. **Provenance on everything.** Each fact carries `verified`, `reported` or
   `inferred`, and inferred facts are marked as such all the way into the prompt.

Run with:  python -m app.seed.enrose
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal, create_all
from app.enums import Confidence
from app.models.brand import (
    Audience,
    Brand,
    Competitor,
    ContentPillar,
    Product,
    Service,
)
from app.models.tenancy import Client, Membership, User
from app.security import hash_password

CLIENT_SLUG = "enrose"
DEFAULT_EMAIL = "owner@enrosesalon.com"
DEFAULT_PASSWORD = "enrose-dev-password"  # development only; change on first deploy

SOURCE_SITE = "enrosesalon.com (indexed summary)"
SOURCE_DIR = "business directory listing"

# ── Services (verified at the service-name level; no price is known) ─────────
SERVICES: list[tuple[str, str, str | None]] = [
    ("Haircut — Style Director", "hair", "Cut and finish by a Style Director."),
    ("Haircut — Senior Stylist", "hair", "Cut and finish by a Senior Stylist."),
    ("Hair Colour", "hair", "Professional colour service."),
    ("Balayage", "hair", "Hand-painted, grown-out-friendly lightening."),
    ("Highlights", "hair", "Foil-based lightening."),
    ("Nanoplastia", "hair", "Smoothing and texture treatment."),
    ("Keratin Treatment", "hair", "Smoothing and frizz-control treatment."),
    ("Hair Botox", "hair", "Conditioning and smoothing treatment."),
    ("Hair Rituals by Kérastase", "hair", "In-salon Kérastase ritual treatments."),
    ("Essential Cleanup", "skin", "Entry-level skin cleanup."),
    ("Advanced Facial", "skin", "Advanced facial treatment."),
    ("Signature Facial Advanced", "skin", "Signature advanced facial."),
    ("HydraMemory", "skin", "Hydration-focused facial ritual."),
    ("Bioline Skin Rituals", "skin", "Bioline-based skin ritual treatments."),
    ("Gel Extensions", "nails", "Gel nail extensions."),
    ("Acrylic Extensions", "nails", "Acrylic nail extensions."),
    ("Ombre Nails", "nails", "Ombre nail finish."),
    ("Chrome Nails", "nails", "Chrome nail finish."),
    ("Cat Eye Nails", "nails", "Magnetic cat-eye nail finish."),
    ("Custom Nail Art", "nails", "Bespoke nail art."),
    ("Swedish Massage", "spa", "Classic relaxation massage."),
    ("Deep Tissue Massage", "spa", "Deep-pressure massage."),
    ("Detox Massage", "spa", "Detox-focused massage."),
    ("Bridal Makeup", "bridal", "Bridal makeup application."),
]

# Verified product partners. The only brands the AI may name.
PRODUCTS = [
    ("Kérastase", "haircare"),
    ("Bioline", "skincare"),
    ("Cuccio", "nails"),
    ("Blue Sky", "nails"),
    ("Redken", "haircare"),
    ("L'Oréal Professionnel", "haircare"),
]

# Directory-listed local competitors. No engagement data is claimed for any of them.
COMPETITORS = [
    ("Lakme Salon, Bistupur", None, "national", "Unite Mall, Bistupur. National chain; strongest local brand recognition."),
    ("The Jawed Habib Salon, Bistupur", None, "national", "H S Tower, L Road, Bistupur. National chain."),
    ("Moraja — The Family Salon", None, "local", "Opposite Ram Mandir, Bistupur. Local unisex salon."),
    ("Enrich Salons (Jamshedpur)", None, "national", "National chain; presence indicated by directory listings."),
    ("Sun Spa & Wellness Retreat", None, "local", "Local spa-led competitor."),
]

# Seed candidates only — agents may reweight, add or retire these.
PILLARS = [
    ("transformation", "Transformation", "Before and after across hair, nails, skin and bridal.", "reach", 0.28,
     ["Balayage reveal", "Colour correction", "Nail set build", "Bridal look"]),
    ("education", "Education", "Haircare, skin and nail guidance that earns a save.", "saves", 0.22,
     ["Monsoon frizz routine", "Trim frequency myths", "Heat protectant"]),
    ("authority", "Authority", "Stylist expertise, treatment science, professional judgement.", "authority", 0.15,
     ["Nanoplastia vs keratin", "Stylist tiers explained"]),
    ("behind_the_scenes", "Behind the scenes", "Process, team and salon environment.", "community", 0.12,
     ["Morning setup", "Bridal trial prep"]),
    ("social_proof", "Social proof", "Genuine client reactions and results, captured with consent.", "engagement", 0.10,
     ["Mirror reaction", "First big chop"]),
    ("products", "Products", "The professional roster and why it is used.", "authority", 0.07,
     ["Choosing a Kérastase ritual", "Why professional colour differs"]),
    ("conversion", "Conversion", "Services, consultations and appointments. No invented offers.", "bookings", 0.06,
     ["Bridal timeline", "Festive prep window"]),
]

# Inferred from the service mix and location. Marked inferred, never asserted as fact.
AUDIENCES = [
    ("Local premium regulars", {"age": "25-45", "gender": "predominantly women", "location": "Jamshedpur / Bistupur"},
     ["Inconsistent results elsewhere", "Colour fading quickly", "Not being listened to in consultation"],
     ["A stylist who understands their hair", "Results that last", "A calm, unhurried experience"], 1),
    ("Bridal clients and their families", {"age": "21-35", "occasion": "wedding", "location": "Jamshedpur and surrounding Jharkhand"},
     ["High stakes with no room for error", "Unclear preparation timelines", "Coordinating multiple services"],
     ["A trial before the day", "One salon for hair, skin, nails and makeup", "Reassurance"], 2),
    ("Treatment seekers", {"age": "22-40", "interest": "smoothing and repair treatments"},
     ["Frizz and humidity", "Confusion between treatment types", "Fear of damaging hair"],
     ["Honest advice on what suits their hair", "A manageable daily routine"], 3),
]

# Recorded as unknown rather than guessed. Each one narrows what the engine may say.
UNKNOWN_FIELDS = [
    "service_pricing", "current_offers", "packages", "loyalty_programme",
    "phone_number", "email", "booking_link", "staff_names", "stylist_specialisms",
    "client_testimonials", "review_ratings", "awards_certifications", "founding_year",
    "brand_colors", "brand_fonts", "logo",
    "instagram_follower_count", "instagram_posting_cadence", "instagram_top_posts",
    "instagram_historical_engagement", "additional_branches", "mens_grooming_positioning",
    "client_filming_consent_policy",
]


def seed(db: Session, *, email: str = DEFAULT_EMAIL, password: str = DEFAULT_PASSWORD) -> dict:
    """Idempotent: re-running updates the brand rather than duplicating it."""
    client = db.execute(select(Client).where(Client.slug == CLIENT_SLUG)).scalars().first()
    if client is None:
        client = Client(name="Enrose Salon", slug=CLIENT_SLUG, timezone="Asia/Kolkata", status="active")
        db.add(client)
        db.flush()

    user = db.execute(select(User).where(User.email == email.lower())).scalars().first()
    if user is None:
        user = User(
            email=email.lower(),
            full_name="Enrose Salon Owner",
            password_hash=hash_password(password),
            role="owner",
        )
        db.add(user)
        db.flush()

    if db.execute(
        select(Membership).where(Membership.user_id == user.id, Membership.client_id == client.id)
    ).scalars().first() is None:
        db.add(Membership(user_id=user.id, client_id=client.id, role="owner"))
        db.flush()

    brand = db.execute(select(Brand).where(Brand.client_id == client.id)).scalars().first()
    if brand is None:
        brand = Brand(client_id=client.id, name="Enrose Salon")
        db.add(brand)
        db.flush()

    brand.website = "https://www.enrosesalon.com/"
    brand.instagram_handle = "enrosesalon"
    brand.description = (
        "Enrose Salon is a premium salon in Bistupur, Jamshedpur, offering hair, skin, nails, spa "
        "and bridal services. The brand describes itself as \"India's growing premium luxury salon\" "
        "and frames its services as rituals rather than transactions."
    )
    brand.positioning = (
        "A craft-led premium salon competing on expertise and professional product quality rather "
        "than price. Differentiated by its professional roster (Kérastase, Bioline, Cuccio, Blue Sky, "
        "Redken, L'Oréal Professionnel), a two-tier stylist system (Style Director / Senior Stylist), "
        "and experiential 'ritual' service framing."
    )
    brand.tone = {
        "rules": [
            "Calm, expert and unhurried — never urgent or discount-driven.",
            "Use the brand's own vocabulary: ritual, Style Director, Senior Stylist, Signature.",
            "Explain the craft; assume an intelligent reader.",
            "Speak to one person, not an audience.",
            "Never state a price, discount or offer.",
            "Never promise a clinical or medical outcome.",
        ],
        "words_to_favour": ["ritual", "craft", "considered", "expert", "consultation", "finish", "tailored"],
        "vocabulary_source": "Lifted from Enrose's own published copy.",
    }
    brand.visual_identity = {
        "direction": [
            "Warm neutral palette with soft directional light.",
            "Real salon interiors — no stock imagery.",
            "Close-up craft detail: hands, texture, product.",
            "Unhurried pacing; let the result hold on screen.",
        ],
        "colors": None,   # UNKNOWN — client must supply
        "fonts": None,    # UNKNOWN — client must supply
        "logo_key": None,
    }
    brand.locations = [
        {
            "label": "Bistupur",
            "address": "Contractors Area, Road No. 2, Bistupur",
            "city": "Jamshedpur",
            "state": "Jharkhand",
            "country": "India",
            "hours": "Daily 9:00 AM – 9:00 PM",
            "notes": "Walk-ins reported welcome Friday and Saturday.",
            "confidence": Confidence.REPORTED.value,
        }
    ]
    brand.business_goals = [
        {"goal": "Establish Enrose as the local authority on hair craft rather than the cheapest chair."},
        {"goal": "Convert Instagram profile visits into consultations and bookings."},
        {"goal": "Build a saveable education library that compounds in reach."},
        {"goal": "Own bridal season in Jamshedpur with early, useful planning content."},
    ]
    brand.words_to_avoid = [
        "cheap", "discount", "offer", "deal", "guaranteed", "miracle", "permanent cure",
        "best in India", "clinically proven", "#1", "award-winning",
    ]
    brand.claims_to_avoid = [
        "Any price, package or promotional claim.",
        "Any medical, dermatological or therapeutic outcome.",
        "Any client testimonial, review or rating.",
        "Any certification, award or ranking.",
        "Any service or product brand not listed in this Brand Brain.",
        "Any specific local event, festival date or venue.",
        "Any claim about Enrose's Instagram performance or following.",
    ]
    brand.unknown_fields = UNKNOWN_FIELDS
    brand.provenance = {
        "name": Confidence.VERIFIED.value,
        "website": Confidence.VERIFIED.value,
        "instagram_handle": Confidence.VERIFIED.value,
        "description": Confidence.VERIFIED.value,
        "positioning": Confidence.INFERRED.value,
        "services": Confidence.VERIFIED.value,
        "products": Confidence.VERIFIED.value,
        "location_city_area": Confidence.VERIFIED.value,
        "location_address": Confidence.REPORTED.value,
        "hours": Confidence.VERIFIED.value,
        "audiences": Confidence.INFERRED.value,
        "tone": Confidence.INFERRED.value,
        "competitors": Confidence.REPORTED.value,
        "research_note": (
            "enrosesalon.com and instagram.com/enrosesalon are blocked by this environment's network "
            "egress proxy. Facts come from search-engine summaries quoting those pages plus business "
            "directory listings. See docs/BRAND_RESEARCH.md."
        ),
    }

    existing_services = {
        s.name for s in db.execute(select(Service).where(Service.brand_id == brand.id)).scalars().all()
    }
    for name, category, description in SERVICES:
        if name in existing_services:
            continue
        db.add(
            Service(
                client_id=client.id, brand_id=brand.id, name=name, category=category,
                description=description,
                price=None,  # UNKNOWN — no price is published anywhere
                currency=None,
                confidence=Confidence.VERIFIED.value,
                source=SOURCE_SITE,
            )
        )

    existing_products = {
        p.brand_name for p in db.execute(select(Product).where(Product.brand_id == brand.id)).scalars().all()
    }
    for brand_name, category in PRODUCTS:
        if brand_name in existing_products:
            continue
        db.add(
            Product(
                client_id=client.id, brand_id=brand.id, brand_name=brand_name, category=category,
                confidence=Confidence.VERIFIED.value, source=SOURCE_SITE,
            )
        )

    existing_audiences = {
        a.segment for a in db.execute(select(Audience).where(Audience.brand_id == brand.id)).scalars().all()
    }
    for segment, demographics, pains, desires, priority in AUDIENCES:
        if segment in existing_audiences:
            continue
        db.add(
            Audience(
                client_id=client.id, brand_id=brand.id, segment=segment, demographics=demographics,
                pains=pains, desires=desires, priority=priority,
                confidence=Confidence.INFERRED.value,
            )
        )

    existing_competitors = {
        c.name for c in db.execute(select(Competitor).where(Competitor.client_id == client.id)).scalars().all()
    }
    for name, handle, tier, notes in COMPETITORS:
        if name in existing_competitors:
            continue
        db.add(
            Competitor(
                client_id=client.id, name=name, handle=handle, tier=tier,
                notes=f"{notes} Source: {SOURCE_DIR}. No engagement data available.",
            )
        )

    existing_pillars = {
        p.key for p in db.execute(select(ContentPillar).where(ContentPillar.client_id == client.id)).scalars().all()
    }
    for key, label, description, objective, weight, examples in PILLARS:
        if key in existing_pillars:
            continue
        db.add(
            ContentPillar(
                client_id=client.id, key=key, label=label, description=description,
                objective=objective, weight=weight, examples=examples, source="seed",
            )
        )

    db.commit()

    from app.services import brand_service, publishing_service

    completeness, missing = brand_service.compute_completeness(db, client.id)
    db.commit()
    # A labelled mock connection, so the publish pipeline is exercisable immediately.
    publishing_service.connect_mock_account(db, client.id)

    return {
        "client_id": str(client.id),
        "brand_id": str(brand.id),
        "user_email": user.email,
        "services": len(SERVICES),
        "products": len(PRODUCTS),
        "pillars": len(PILLARS),
        "competitors": len(COMPETITORS),
        "unknown_fields": len(UNKNOWN_FIELDS),
        "completeness": completeness,
        "missing_fields": missing,
    }


def main() -> None:
    """CLI entrypoint.

    Credentials come from the environment when present, so a real deployment never
    has to ship with the development password baked into source.
    """
    import os

    email = os.environ.get("SEED_OWNER_EMAIL", DEFAULT_EMAIL)
    password = os.environ.get("SEED_OWNER_PASSWORD", DEFAULT_PASSWORD)

    if password == DEFAULT_PASSWORD and os.environ.get("APP_ENV") == "production":
        raise SystemExit(
            "Refusing to seed a production environment with the development password. "
            "Set SEED_OWNER_PASSWORD (and optionally SEED_OWNER_EMAIL) first."
        )

    create_all()
    with SessionLocal() as db:
        result = seed(db, email=email, password=password)

    print("Enrose Brand Brain seeded.\n")
    for key, value in result.items():
        if key == "missing_fields":
            continue
        print(f"  {key:18} {value}")
    print(f"\n  Brand completeness: {result['completeness']}%")
    print(f"  Fields the client still needs to supply ({len(result['missing_fields'])}):")
    for field in result["missing_fields"]:
        print(f"    - {field}")
    print(f"\n  Login: {result['user_email']}")
    if password == DEFAULT_PASSWORD:
        print(f"  Password: {DEFAULT_PASSWORD}  (development default — change it before deploying)")
    else:
        print("  Password: taken from SEED_OWNER_PASSWORD")


if __name__ == "__main__":
    main()

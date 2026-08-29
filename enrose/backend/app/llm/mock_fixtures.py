"""Deterministic fixtures for `MockProvider`.

Every fixture must validate against its agent's Pydantic schema — the test suite
asserts exactly that, so a schema change that breaks the mock is caught immediately
rather than at runtime with a real key.

Two rules these fixtures obey, because they are the same rules production content
obeys and the tests check them:

1. **No fabricated facts.** No prices, offers, testimonials, medical claims, or
   services Enrose does not offer. Only the verified product brands are named.
2. **Real variety.** Drafts are selected from pools keyed on a hash of the prompt,
   so generating a month of content produces genuinely different items rather than
   sixteen copies that the duplicate detector would (correctly) reject.
"""

from __future__ import annotations

import hashlib
from typing import Any

# Verified from docs/BRAND_RESEARCH.md — the only product brands the AI may name.
PRODUCT_BRANDS = ["Kérastase", "Bioline", "Cuccio", "Blue Sky", "Redken", "L'Oréal Professionnel"]


def _pick(prompt: str, pool: list[Any], salt: str = "") -> Any:
    """Stable pseudo-random choice: same prompt always yields the same item."""
    digest = hashlib.sha256((salt + prompt).encode("utf-8")).hexdigest()
    return pool[int(digest[:8], 16) % len(pool)]


def _hash_int(prompt: str, salt: str, lo: int, hi: int) -> int:
    digest = hashlib.sha256((salt + prompt).encode("utf-8")).hexdigest()
    return lo + (int(digest[8:16], 16) % (hi - lo + 1))


# ── Concept pools ───────────────────────────────────────────────────────────
# Grounded in Enrose's actual, verified service lines: hair (colour, balayage,
# Nanoplastia/Keratin/Botox, Kérastase rituals), skin (Bioline), nails (Cuccio /
# Blue Sky), spa, bridal.

REEL_CONCEPTS: list[dict[str, str]] = [
    {
        "topic": "balayage transformation reveal",
        "pillar": "transformation",
        "hook": "She asked for 'natural, but expensive-looking'.",
        "objective": "reach",
    },
    {
        "topic": "why your hair feels dry after colouring",
        "pillar": "education",
        "hook": "Your hair isn't damaged because you use heat.",
        "objective": "saves",
    },
    {
        "topic": "Nanoplastia versus keratin explained",
        "pillar": "authority",
        "hook": "Nanoplastia and keratin are not the same treatment.",
        "objective": "authority",
    },
    {
        "topic": "chrome nail art close-up process",
        "pillar": "transformation",
        "hook": "Watch the chrome shift under the light.",
        "objective": "engagement",
    },
    {
        "topic": "bridal hair trial behind the scenes",
        "pillar": "behind_the_scenes",
        "hook": "The bridal trial is the appointment nobody books early enough.",
        "objective": "bookings",
    },
    {
        "topic": "how a Kérastase ritual is actually chosen",
        "pillar": "products",
        "hook": "Your stylist doesn't pick that bottle at random.",
        "objective": "authority",
    },
    {
        "topic": "monsoon frizz routine for Jamshedpur humidity",
        "pillar": "education",
        "hook": "Humidity isn't causing your frizz. Your routine is.",
        "objective": "saves",
    },
    {
        "topic": "client reaction to first big chop",
        "pillar": "social_proof",
        "hook": "She sat down saying 'don't take much off'.",
        "objective": "engagement",
    },
    {
        "topic": "what a Bioline facial actually does to your skin",
        "pillar": "education",
        "hook": "A cleanup and a facial are not the same thing.",
        "objective": "saves",
    },
    {
        "topic": "gel extensions from bare nail to finished set",
        "pillar": "transformation",
        "hook": "Bare nail to full set, start to finish.",
        "objective": "reach",
    },
    {
        "topic": "the three-minute blow-dry section rule",
        "pillar": "education",
        "hook": "You're drying too much hair at once.",
        "objective": "saves",
    },
    {
        "topic": "stylist tiers explained: Style Director vs Senior Stylist",
        "pillar": "authority",
        "hook": "What actually changes when you book a Style Director?",
        "objective": "bookings",
    },
    {
        "topic": "colour correction rescue on box dye",
        "pillar": "transformation",
        "hook": "Box dye is not a mistake. It's just harder to undo.",
        "objective": "reach",
    },
    {
        "topic": "salon morning setup before the first client",
        "pillar": "behind_the_scenes",
        "hook": "9AM. Nobody's here yet.",
        "objective": "community",
    },
    {
        "topic": "how often you actually need a trim",
        "pillar": "education",
        "hook": "Trimming more often does not make hair grow faster.",
        "objective": "saves",
    },
    {
        "topic": "festive season hair prep timeline",
        "pillar": "conversion",
        "hook": "Book the treatment three weeks before, not three days.",
        "objective": "bookings",
    },
]

CAROUSEL_CONCEPTS: list[dict[str, str]] = [
    {"topic": "hair habits quietly damaging your colour", "pillar": "education", "hook": "5 habits quietly damaging your colour"},
    {"topic": "how to prepare for your first balayage", "pillar": "education", "hook": "Booking balayage for the first time? Read this."},
    {"topic": "nail shapes and which suits your hand", "pillar": "education", "hook": "Your nail shape is fighting your hand shape."},
    {"topic": "bridal beauty timeline", "pillar": "conversion", "hook": "Your bridal beauty timeline, month by month"},
    {"topic": "smoothing treatments compared", "pillar": "authority", "hook": "Keratin vs Botox vs Nanoplastia, honestly compared"},
    {"topic": "what your skin type actually needs", "pillar": "education", "hook": "You're probably treating the wrong skin type"},
    {"topic": "monsoon haircare rules", "pillar": "education", "hook": "6 monsoon haircare rules for Jamshedpur"},
    {"topic": "questions to ask before colouring", "pillar": "authority", "hook": "Ask your stylist these 5 questions before you colour"},
]


def _reel_draft(prompt: str) -> dict[str, Any]:
    c = _pick(prompt, REEL_CONCEPTS, salt="reel")
    topic = c["topic"]
    return {
        "title": topic.title(),
        "concept": (
            f"A {c['pillar'].replace('_', ' ')} reel built around {topic}, shot in-salon with "
            "natural light and a clear visual payoff in the final three seconds."
        ),
        "pillar": c["pillar"],
        "objective": c["objective"],
        "hook": c["hook"],
        "first_three_seconds": (
            f"Open mid-action on the strongest visual, text overlay reads: '{c['hook']}'. No intro, no logo."
        ),
        "script": (
            f"{c['hook']}\n\n"
            "Beat 1 — state the situation the viewer recognises.\n"
            "Beat 2 — show the professional process, not just the result.\n"
            "Beat 3 — explain the one thing most people get wrong.\n"
            "Beat 4 — reveal the payoff and hold on it.\n"
            "Close — one clear next step."
        ),
        "shots": [
            {"index": 1, "duration_s": 2.5, "description": f"Close-up establishing shot for {topic}", "camera": "Handheld close-up, slow push in", "on_screen_text": c["hook"]},
            {"index": 2, "duration_s": 4.0, "description": "Stylist working — hands and product visible", "camera": "Over-the-shoulder, tripod", "on_screen_text": "The part nobody films"},
            {"index": 3, "duration_s": 4.5, "description": "Explanation beat with clear demonstration", "camera": "Mid shot, eye level", "on_screen_text": None},
            {"index": 4, "duration_s": 3.5, "description": "Final reveal, hold on the result", "camera": "Slow orbit around the chair", "on_screen_text": "Result"},
            {"index": 5, "duration_s": 2.0, "description": "Client reaction in the mirror", "camera": "Mirror reflection, static", "on_screen_text": None},
        ],
        "on_screen_text": [c["hook"], "The part nobody films", "Here's what actually matters", "Result"],
        "voiceover": "Calm, conversational stylist voice. Explain, don't sell.",
        "editing_instructions": [
            "Cut on motion — never hold a static frame longer than 2s in the first half.",
            "Hard cut at 0:03 to reset attention.",
            "Match-cut before and after on the same head angle.",
            "Hold the final reveal for a full 2s so it is screenshot-able.",
            "Captions burned in — assume sound-off viewing.",
        ],
        "broll_requirements": [
            "Product on the trolley (in-focus, brand visible)",
            "Wide salon interior for context",
            "Detail shot of hands working",
        ],
        "music_direction": "Warm, unhurried, low-percussion. Nothing that fights the voiceover.",
        "cta": "Save this before your next salon appointment.",
        "caption": (
            f"{c['hook']}\n\n"
            f"Here's what actually changes when {topic} is done properly — and the one step most people skip at home.\n\n"
            "Our stylists talk you through it before anything starts.\n\n"
            "Save this for your next appointment."
        ),
        "hashtags": [
            "#enrosesalon", "#jamshedpur", "#bistupur", "#hairtransformation",
            "#salonjamshedpur", "#haircare", "#jharkhand",
        ],
        "cover_text": c["hook"][:40],
        "estimated_duration_s": 16.5,
    }


def _carousel_draft(prompt: str) -> dict[str, Any]:
    c = _pick(prompt, CAROUSEL_CONCEPTS, salt="carousel")
    points = [
        ("Washing with water that's too hot", "Heat lifts the cuticle and colour escapes faster. Lukewarm is enough."),
        ("Skipping heat protectant", "It is not optional. It is the barrier between your hair and 200°C."),
        ("Brushing hair while soaking wet", "Wet hair stretches. Detangle from the ends, with a wide tooth comb."),
        ("Using the wrong shampoo for treated hair", "Colour-treated hair needs a formula built for it, not whatever is in the shower."),
        ("Leaving too long between salon visits", "Small corrections are easy. Grown-out damage is not."),
    ]
    slides: list[dict[str, Any]] = [
        {"index": 1, "headline": c["hook"], "body": None, "visual_instruction": "Bold cover type over a clean salon detail shot, high contrast", "template_key": "cover_bold"}
    ]
    for i, (headline, body) in enumerate(points, start=2):
        slides.append(
            {
                "index": i,
                "headline": f"{i - 1}. {headline}",
                "body": body,
                "visual_instruction": "Single supporting image, generous margins, one idea per slide",
                "template_key": "point_numbered",
            }
        )
    slides.append(
        {
            "index": len(slides) + 1,
            "headline": "Book a consultation",
            "body": "Our stylists will tell you which of these is actually affecting your hair.",
            "visual_instruction": "Salon interior, logo lockup bottom-right, clear CTA type",
            "template_key": "cta_close",
        }
    )
    return {
        "title": c["topic"].title(),
        "pillar": c["pillar"],
        "objective": "saves",
        "hook": c["hook"],
        "cover_text": c["hook"],
        "slides": slides,
        "cta": "Save this — and send it to whoever needs to read it.",
        "caption": (
            f"{c['hook']}\n\nSwipe through — most of these are small habits, not big mistakes.\n\n"
            "Save it for later, and bring your questions to your next appointment."
        ),
        "hashtags": ["#enrosesalon", "#jamshedpur", "#bistupur", "#haircaretips", "#salonjamshedpur"],
    }


def _virality_assessment(prompt: str) -> dict[str, Any]:
    def dim(base: int, salt: str, reason: str) -> dict[str, Any]:
        return {"score": float(min(97, max(35, base + _hash_int(prompt, salt, -8, 8)))), "reason": reason}

    return {
        "hook_strength": dim(82, "hook", "Opens on a contradiction the viewer wants resolved."),
        "curiosity": dim(78, "cur", "The payoff is withheld until the final beat."),
        "emotional_response": dim(74, "emo", "Transformation content reliably triggers a satisfaction response."),
        "shareability": dim(70, "share", "Useful enough to send to a friend planning an appointment."),
        "saveability": dim(85, "save", "Practical and referenceable before a salon visit."),
        "rewatch_potential": dim(72, "rewatch", "Visual payoff rewards a second viewing."),
        "relatability": dim(80, "rel", "Names a problem the audience already has."),
        "trend_alignment": dim(66, "trend", "Uses a durable format rather than a fading audio trend."),
        "visual_transformation": dim(84, "vis", "Clear before and after within a single frame pair."),
        "audience_relevance": dim(88, "aud", "Directly relevant to the local premium salon audience."),
        "brand_fit": dim(90, "fit", "Consistent with the ritual-led, craft-first positioning."),
        "conversion_potential": dim(76, "conv", "CTA points to a real next step without inventing an offer."),
        "predicted_top_percentile": float(_hash_int(prompt, "pct", 60, 92)),
        "biggest_weakness": "Trend alignment is the weakest dimension — the format is durable but not currently amplified.",
        "concrete_fix": "Cut the first shot 0.5s tighter and put the contradiction on screen at frame one.",
        "explanation": (
            "Scores highest on brand fit, audience relevance and saveability, which is the right profile "
            "for a salon optimising for bookings rather than raw reach."
        ),
    }


def _qa_report(prompt: str) -> dict[str, Any]:
    return {
        "checks": [
            {"check": "brand_consistency", "passed": True, "severity": "info", "detail": "Tone matches the ritual-led, unhurried house style."},
            {"check": "grammar", "passed": True, "severity": "info", "detail": "No grammatical issues found."},
            {"check": "factual_accuracy", "passed": True, "severity": "info", "detail": "All services named exist in the brand brain."},
            {"check": "no_invented_pricing", "passed": True, "severity": "blocking", "detail": "No prices, discounts or offers present."},
            {"check": "no_medical_claims", "passed": True, "severity": "blocking", "detail": "No clinical or medical outcome claims."},
            {"check": "no_fabricated_testimonials", "passed": True, "severity": "blocking", "detail": "No invented client quotes or reviews."},
            {"check": "cta_quality", "passed": True, "severity": "warning", "detail": "CTA is specific and actionable."},
            {"check": "hook_strength", "passed": True, "severity": "warning", "detail": "Hook lands within the first three seconds."},
            {"check": "repetition", "passed": True, "severity": "warning", "detail": "No close match against recent content memory."},
            {"check": "platform_compliance", "passed": True, "severity": "info", "detail": "Within Instagram caption and hashtag limits."},
        ],
        "approved": True,
        "blocking_reasons": [],
        "suggested_edits": ["Consider tightening the caption's second paragraph by one line."],
        "summary": "Passes all blocking checks. Safe to send to the client for approval.",
    }


def _brand_strategy(prompt: str) -> dict[str, Any]:
    return {
        "positioning": (
            "Enrose is a premium, craft-led salon in Bistupur, Jamshedpur, offering hair, skin, nails, "
            "spa and bridal services framed as rituals rather than transactions. It competes on expertise "
            "and professional product quality, not on price."
        ),
        "tone_rules": [
            "Calm, expert and unhurried — never urgent or discount-driven.",
            "Use the brand's own vocabulary: ritual, Style Director, Senior Stylist, Signature.",
            "Explain the craft; assume an intelligent reader.",
            "Never state a price, discount or offer.",
            "Never promise a clinical or medical outcome.",
            "Speak to one person, not an audience.",
        ],
        "words_to_favour": ["ritual", "craft", "considered", "expert", "consultation", "finish", "tailored"],
        "words_to_avoid": ["cheap", "discount", "guaranteed", "miracle", "permanent cure", "best in India", "clinically proven"],
        "visual_direction": [
            "Warm neutral palette with soft directional light.",
            "Real salon interiors — no stock imagery.",
            "Close-up craft detail: hands, texture, product.",
            "Unhurried pacing; let the result hold on screen.",
        ],
        "audiences": [
            {
                "segment": "Local premium regulars",
                "demographics": {"age": "25-45", "gender": "predominantly women", "location": "Jamshedpur / Bistupur"},
                "pains": ["Inconsistent results elsewhere", "Colour fading quickly", "Not being listened to in consultation"],
                "desires": ["A stylist who understands their hair", "Results that last", "A calm experience"],
                "priority": 1,
                "confidence": "inferred",
            },
            {
                "segment": "Bridal clients and their families",
                "demographics": {"age": "21-35", "occasion": "wedding", "location": "Jamshedpur and surrounding Jharkhand"},
                "pains": ["High stakes, no room for error", "Unclear timelines", "Coordinating multiple services"],
                "desires": ["Trial before the day", "One salon for hair, skin, nails and makeup", "Reassurance"],
                "priority": 2,
                "confidence": "inferred",
            },
            {
                "segment": "Treatment seekers",
                "demographics": {"age": "22-40", "interest": "smoothing and repair treatments"},
                "pains": ["Frizz and humidity", "Confusion between treatment types", "Fear of damage"],
                "desires": ["Honest advice on what suits their hair", "Manageable daily routine"],
                "priority": 3,
                "confidence": "inferred",
            },
        ],
        "pillars": [
            {"key": "transformation", "label": "Transformation", "description": "Before and after across hair, nails, skin and bridal.", "objective": "reach", "weight": 0.28, "examples": ["Balayage reveal", "Colour correction", "Bridal look build"]},
            {"key": "education", "label": "Education", "description": "Haircare, skin and nail guidance that earns a save.", "objective": "saves", "weight": 0.22, "examples": ["Monsoon frizz routine", "Trim frequency myths"]},
            {"key": "authority", "label": "Authority", "description": "Stylist expertise, treatment science, professional judgement.", "objective": "authority", "weight": 0.15, "examples": ["Nanoplastia vs keratin", "Stylist tiers explained"]},
            {"key": "behind_the_scenes", "label": "Behind the scenes", "description": "Process, team and salon environment.", "objective": "community", "weight": 0.12, "examples": ["Morning setup", "Bridal trial prep"]},
            {"key": "social_proof", "label": "Social proof", "description": "Genuine client reactions and results, captured with consent.", "objective": "engagement", "weight": 0.10, "examples": ["Mirror reaction", "First big chop"]},
            {"key": "products", "label": "Products", "description": "The professional roster and why it is used.", "objective": "authority", "weight": 0.07, "examples": ["Choosing a Kérastase ritual", "Why professional colour differs"]},
            {"key": "conversion", "label": "Conversion", "description": "Services, consultations and appointment prompts. No invented offers.", "objective": "bookings", "weight": 0.06, "examples": ["Bridal timeline", "Festive prep window"]},
        ],
        "strategic_objectives": [
            "Establish Enrose as the local authority on hair craft rather than the cheapest chair.",
            "Convert profile visits into consultations and bookings.",
            "Build a saveable education library that compounds in reach.",
            "Own bridal season in Jamshedpur with early, useful planning content.",
        ],
        "information_gaps": [
            "Service pricing (not published anywhere — required before any offer or package content).",
            "Current Instagram metrics: follower count, cadence, historical top posts.",
            "Stylist names and specialisms for authority content.",
            "Brand colour hex values and typefaces for template rendering.",
            "Canonical booking link and phone number for CTAs.",
            "Consent policy for filming clients.",
        ],
        "rationale": (
            "Enrose's defensible advantages are its professional product roster, its stylist-tier system and "
            "its ritual framing. National chains compete locally on price and familiarity; matching them there "
            "would erode the premium position. The pillar mix therefore leads with transformation for reach "
            "and education for saves, with conversion kept deliberately small until pricing and booking "
            "details are confirmed by the client."
        ),
    }


def _content_strategy(prompt: str) -> dict[str, Any]:
    ideas = []
    for i, c in enumerate(REEL_CONCEPTS[:10], start=1):
        ideas.append(
            {
                "title": c["topic"].title(),
                "pillar": c["pillar"],
                "format": "reel",
                "objective": c["objective"],
                "hook": c["hook"],
                "summary": f"Reel built around {c['topic']}, shot in-salon.",
                "priority": (i % 5) + 1,
                "rationale": "Fits the leading pillar for this cycle and is producible from routine salon appointments.",
            }
        )
    for i, c in enumerate(CAROUSEL_CONCEPTS[:6], start=1):
        ideas.append(
            {
                "title": c["topic"].title(),
                "pillar": c["pillar"],
                "format": "carousel",
                "objective": "saves",
                "hook": c["hook"],
                "summary": f"Carousel on {c['topic']}.",
                "priority": (i % 5) + 1,
                "rationale": "Education carousels are the cheapest reliable route to saves and profile visits.",
            }
        )
    return {
        "title": "Content cycle strategy",
        "pillar_mix": {
            "transformation": 0.28, "education": 0.22, "authority": 0.15,
            "behind_the_scenes": 0.12, "social_proof": 0.10, "products": 0.07, "conversion": 0.06,
        },
        "posting_frequency": {"reels_per_week": 4, "carousels_per_week": 2, "stories_per_day": 2},
        "format_split": {"reel": 16, "carousel": 8, "static": 0, "story": 60},
        "objectives": [
            {"objective": "reach", "target": "Grow non-follower reach via transformation reels", "why": "Transformation is the strongest cold-audience format for a salon."},
            {"objective": "saves", "target": "Build a saveable education library", "why": "Saves signal durable value and correlate with return visits."},
            {"objective": "bookings", "target": "Convert profile visits into consultations", "why": "Bookings, not views, are the business outcome."},
        ],
        "audience_focus": ["Local premium regulars", "Bridal clients and their families", "Treatment seekers"],
        "themes": ["Craft over price", "Seasonal haircare", "Bridal planning", "Professional products explained"],
        "ideas": ideas,
        "rationale": (
            "Transformation leads for reach because it is the format with the clearest visual payoff and it is "
            "producible from appointments the salon is already doing. Education follows for saves. Conversion is "
            "held at 6% deliberately: without confirmed pricing, promotional content would either be vague or "
            "unsafe, and vague promotional content erodes a premium position faster than posting less of it."
        ),
    }


def _trend_report(prompt: str) -> dict[str, Any]:
    return {
        "trends": [
            {"name": "Unhurried single-take transformation reveals", "category": "format", "description": "One continuous shot from before to reveal, minimal cuts, no trending audio.", "popularity": "rising", "relevance_score": 88.0, "expiry_probability": 0.2, "fits_brand": True, "fit_reason": "Matches the unhurried, craft-led house style and needs no gimmick.", "recommended_adaptation": "Shoot the balayage reveal as one continuous orbit around the chair.", "recommended_action": "adopt"},
            {"name": "Stylist myth-busting to camera", "category": "topic", "description": "Professional corrects a widely believed haircare myth.", "popularity": "peak", "relevance_score": 84.0, "expiry_probability": 0.3, "fits_brand": True, "fit_reason": "Directly supports the authority pillar and the stylist-tier differentiator.", "recommended_adaptation": "Style Director answers the three questions clients ask most.", "recommended_action": "adopt"},
            {"name": "Monsoon frizz and humidity routines", "category": "seasonal", "description": "Regional seasonal haircare concern.", "popularity": "rising", "relevance_score": 82.0, "expiry_probability": 0.5, "fits_brand": True, "fit_reason": "Genuinely relevant to the Jamshedpur climate and to services already offered.", "recommended_adaptation": "A three-step monsoon routine using the professional roster.", "recommended_action": "adopt"},
            {"name": "Chrome and cat-eye nail finishes", "category": "nails", "description": "High-shine nail finishes that film well.", "popularity": "peak", "relevance_score": 79.0, "expiry_probability": 0.4, "fits_brand": True, "fit_reason": "Enrose's nail studio already offers chrome and cat eye.", "recommended_adaptation": "Macro shot of the light shifting across the finish.", "recommended_action": "adopt"},
            {"name": "Loud lip-sync comedy skits", "category": "format", "description": "Fast-cut trending-audio comedy formats.", "popularity": "peak", "relevance_score": 22.0, "expiry_probability": 0.8, "fits_brand": False, "fit_reason": "Tonally incompatible with a premium, calm, craft-led positioning. Adopting it would cheapen the brand for short-lived reach.", "recommended_adaptation": "Do not adopt. If humour is wanted, use dry observational salon POV instead.", "recommended_action": "ignore"},
            {"name": "Price-comparison and discount-led posts", "category": "topic", "description": "Competing openly on price.", "popularity": "peak", "relevance_score": 10.0, "expiry_probability": 0.6, "fits_brand": False, "fit_reason": "Directly contradicts the premium position, and no pricing is confirmed in the brand brain.", "recommended_adaptation": "Do not adopt.", "recommended_action": "ignore"},
        ],
        "seasonal_opportunities": [
            "Wedding season planning content (roughly Nov–Feb and Apr–Jun)",
            "Monsoon haircare (roughly Jun–Sep)",
            "Festive season preparation around Durga Puja and Diwali",
            "Summer skin and sun-exposure care (Apr–Jun)",
        ],
        "hook_patterns": [
            "Contradict a widely held belief in the first four words.",
            "Open mid-action, never with an introduction.",
            "Name the exact situation the viewer is in.",
            "State the mistake before offering the fix.",
        ],
        "format_patterns": [
            "Single-take reveals over heavily cut montages.",
            "Burned-in captions for sound-off viewing.",
            "Hold the final result for a full two seconds.",
        ],
        "summary": (
            "Four trends are worth adopting and two are explicitly rejected. The rejections matter as much as "
            "the adoptions: lip-sync comedy and discount-led posting would both buy short-term reach at the "
            "cost of the premium position Enrose's pricing power depends on."
        ),
    }


def _competitor_report(prompt: str) -> dict[str, Any]:
    return {
        "profiles": [
            {"name": "National chain salons (Bistupur)", "posting_frequency": "Frequent, centrally produced", "dominant_formats": ["static", "reel"], "dominant_topics": ["offers", "seasonal packages", "brand campaigns"], "hook_style": "Offer-led and price-forward", "visual_style": "Templated national brand assets, little local texture", "observed_offers": ["Seasonal promotional messaging observed in category listings"], "engagement_signal": "unknown", "what_works": ["Brand recognition", "Consistent cadence"]},
            {"name": "Local independent salons", "posting_frequency": "Irregular", "dominant_formats": ["static", "reel"], "dominant_topics": ["client results", "service announcements"], "hook_style": "Minimal — results posted without framing", "visual_style": "Phone-shot, inconsistent lighting", "engagement_signal": "unknown", "observed_offers": [], "what_works": ["Authenticity", "Local familiarity"]},
        ],
        "exploitable_gaps": [
            "Nobody locally is explaining the difference between smoothing treatments properly — the highest-intent search question in the category.",
            "Professional product education (Kérastase, Bioline, Redken, L'Oréal Professionnel) is essentially unclaimed locally.",
            "Bridal planning content is posted as finished looks, never as a planning timeline the bride can use months ahead.",
            "Stylist expertise is invisible: no local salon puts a named professional on camera as an authority.",
            "Regional seasonal haircare (Jamshedpur humidity) is not addressed by chain content produced centrally.",
        ],
        "differentiation_strategy": (
            "Compete on craft and explanation, never on price. The chains have budget and recognition; they do not "
            "have a local Style Director willing to explain, on camera, why a treatment suits one head of hair and "
            "not another. That is the position Enrose can hold and they structurally cannot."
        ),
        "do_not_copy": [
            "Discount-led and price-comparison posting.",
            "Centrally templated campaign creative with no local texture.",
            "Posting finished bridal looks with no useful planning context.",
        ],
        "summary": (
            "The competitive set is split between chains competing on price and independents posting results without "
            "framing. Both leave the explanatory, authority-led middle completely open, and that is exactly where "
            "Enrose's product roster and stylist tiers give it an unfair advantage."
        ),
    }


def _performance_analysis(prompt: str) -> dict[str, Any]:
    return {
        "period_days": 30,
        "findings": [
            {
                "headline": "Transformation reels substantially out-reached promotional content",
                "comparison": "Transformation reels generated 2.4× the average reach of promotional reels over the last 30 days.",
                "magnitude": "2.4× reach, 3.1× saves",
                "why": [
                    "A clear visual payoff lands inside the first two seconds.",
                    "Retention holds through the reveal rather than dropping at the hook.",
                    "High save rate signals durable value, which extends distribution.",
                ],
                "evidence": {"transformation_avg_reach": 8400.0, "promotional_avg_reach": 3500.0, "ratio": 2.4},
                "confidence": 0.78,
            },
            {
                "headline": "Educational carousels drove profile visits well above their reach share",
                "comparison": "Educational carousels produced 34% more profile visits per 1,000 reach than transformation reels.",
                "magnitude": "+34% profile visits per 1,000 reach",
                "why": [
                    "Saveable content prompts a profile check before saving.",
                    "Authority framing raises intent to evaluate the salon.",
                ],
                "evidence": {"carousel_visits_per_k": 18.2, "reel_visits_per_k": 13.6, "delta_pct": 34.0},
                "confidence": 0.66,
            },
        ],
        "do_more_of": [
            "Transformation reels with a single-take reveal.",
            "Educational carousels answering a specific question.",
            "Stylist-to-camera authority content.",
        ],
        "do_less_of": ["Generic promotional posts with no visual payoff.", "Static posts with no explanatory hook."],
        "stop_doing": ["Posting finished results with no context or framing."],
        "strategy_deltas": [
            {"pillar": "transformation", "change_pct": 25.0, "reason": "Strongest reach and save performance in the period."},
            {"pillar": "education", "change_pct": 10.0, "reason": "Highest profile-visit efficiency per unit of reach."},
            {"pillar": "conversion", "change_pct": -15.0, "reason": "Lowest engagement and weakest reach; better served indirectly by authority content."},
        ],
        "headline_recommendation": (
            "Increase transformation content by 25% and education by 10% next cycle, funded by cutting direct "
            "promotional posts — those are underperforming on every axis including the bookings axis they exist to serve."
        ),
        "data_sufficiency": "adequate",
        "summary": (
            "The account is being rewarded for craft and explanation and penalised for direct promotion. The "
            "counter-intuitive read: cutting promotional posts should increase bookings, because profile visits "
            "are being driven by authority content and then wasted on a feed that looks like an advert."
        ),
    }


def _learning_update(prompt: str) -> dict[str, Any]:
    return {
        "insights": [
            {"insight": "Before/after hair transformation videos outperform static promotional content by roughly 3.1× in reach and 2.2× in profile visits.", "kind": "format", "evidence": {"reach_ratio": 3.1, "profile_visit_ratio": 2.2, "sample_size": 12.0}, "confidence": 0.75, "expires_in_days": 90},
            {"insight": "Educational carousels convert reach into profile visits more efficiently than any other format, despite lower absolute reach.", "kind": "performance", "evidence": {"visits_per_k_reach": 18.2, "sample_size": 8.0}, "confidence": 0.62, "expires_in_days": 60},
            {"insight": "Hooks that contradict a common belief in the first four words retain materially better than descriptive hooks.", "kind": "topic", "evidence": {"retention_delta_pct": 22.0, "sample_size": 10.0}, "confidence": 0.58, "expires_in_days": 60},
        ],
        "superseded_insights": [],
        "pillar_weight_deltas": {"transformation": 0.05, "education": 0.02, "conversion": -0.04, "products": -0.03},
        "summary": (
            "Three insights recorded. The dominant pattern is that visual payoff drives reach while explanation "
            "drives intent — so the two leading pillars serve different halves of the funnel and should not be "
            "traded off against each other."
        ),
    }


def _footage_analysis(prompt: str) -> dict[str, Any]:
    return {
        "recommended_reel": "Single-take colour transformation with mirror reaction close",
        "concept": (
            "The uploaded clips cover the full technical arc but stop short of the emotional payoff. Build a "
            "transformation reel that front-loads the before, compresses the process, and holds the reveal."
        ),
        "hook": "She sat down asking for 'just a little lighter'.",
        "sequence": [
            {"asset_id": "clip-before", "order": 1, "start_s": 0.0, "end_s": 2.5, "purpose": "Establish the starting point clearly", "overlay_text": "Before"},
            {"asset_id": "clip-color", "order": 2, "start_s": 1.0, "end_s": 5.0, "purpose": "Show the professional process, hands in frame", "overlay_text": "The part nobody films"},
            {"asset_id": "clip-styling", "order": 3, "start_s": 0.5, "end_s": 3.5, "purpose": "Build anticipation before the reveal", "overlay_text": None},
            {"asset_id": "clip-after", "order": 4, "start_s": 0.0, "end_s": 3.0, "purpose": "Hold the reveal long enough to register", "overlay_text": "After"},
        ],
        "music_direction": "Warm and building, with the peak landing on the reveal cut.",
        "caption": (
            "She sat down asking for 'just a little lighter'.\n\n"
            "Swipe-worthy colour is mostly patience — sectioning, placement, and knowing when to stop.\n\n"
            "Book a consultation and we'll talk through what suits your hair before anything starts."
        ),
        "cta": "Book a consultation before your next colour.",
        "missing_shots": [
            {"shot": "Client reaction in the mirror", "why_it_matters": "The emotional payoff is what makes a transformation shareable rather than merely satisfying. Without it the reel ends on a technical note.", "duration_s": 4.0},
            {"shot": "Final close-up of the finished hair", "why_it_matters": "A tight detail shot is what proves the quality of the finish; wide shots flatten texture.", "duration_s": 3.0},
            {"shot": "Stylist reveal / smiling to camera", "why_it_matters": "Puts a named professional on screen, which is the authority differentiator against chain salons.", "duration_s": 3.0},
        ],
        "completeness": 68.0,
        "verdict": "usable_with_gaps",
        "notes": (
            "Good transformation footage detected: before, colour process and styling are all usable. The gap is "
            "the last ten seconds of the appointment — reaction, close-up and stylist reveal. Filming those three "
            "shots takes under a minute and would move this from usable to strong."
        ),
    }


def _capture_checklist(prompt: str) -> dict[str, Any]:
    return {
        "week_of": "current week",
        "days": [
            {"day": "monday", "focus": "Hair transformation", "tasks": [
                {"shot": "Hair before — front and side, good light", "footage_type": "before", "duration_s": 5.0, "why": "Without a clean before, no transformation reel is possible."},
                {"shot": "Stylist working — hands and product in frame", "footage_type": "color", "duration_s": 15.0, "why": "Process footage is what proves craft."},
                {"shot": "Final reveal — slow orbit", "footage_type": "after", "duration_s": 8.0, "why": "The payoff shot the whole edit builds toward."},
                {"shot": "Client mirror reaction", "footage_type": "reaction", "duration_s": 5.0, "why": "The emotional beat that makes it shareable. Film only with consent."},
            ]},
            {"day": "tuesday", "focus": "Nails", "tasks": [
                {"shot": "Bare nail before", "footage_type": "before", "duration_s": 4.0, "why": "Establishes the starting point."},
                {"shot": "Application process macro", "footage_type": "detail", "duration_s": 15.0, "why": "Macro nail process is inherently rewatchable."},
                {"shot": "Finished set turning in the light", "footage_type": "after", "duration_s": 6.0, "why": "Chrome and cat-eye finishes only read on camera in motion."},
            ]},
            {"day": "wednesday", "focus": "Education / authority", "tasks": [
                {"shot": "Stylist to camera answering one client question", "footage_type": "bts", "duration_s": 30.0, "why": "Authority content needs a named professional on screen."},
                {"shot": "Product on trolley, brand visible", "footage_type": "product", "duration_s": 5.0, "why": "B-roll for any product or treatment explainer."},
            ]},
            {"day": "thursday", "focus": "Skin", "tasks": [
                {"shot": "Treatment room setup", "footage_type": "salon", "duration_s": 6.0, "why": "Establishes the premium environment."},
                {"shot": "Facial process — hands and texture", "footage_type": "treatment", "duration_s": 12.0, "why": "Skin content lives on texture detail."},
                {"shot": "Post-treatment skin close-up", "footage_type": "after", "duration_s": 5.0, "why": "Shows the result without claiming a medical outcome."},
            ]},
            {"day": "friday", "focus": "Bridal / spa", "tasks": [
                {"shot": "Bridal trial process", "footage_type": "styling", "duration_s": 20.0, "why": "Bridal planning content needs real trial footage."},
                {"shot": "Spa room ambience", "footage_type": "salon", "duration_s": 6.0, "why": "Supports the ritual framing."},
            ]},
            {"day": "saturday", "focus": "Salon life / social proof", "tasks": [
                {"shot": "Busy salon wide shot", "footage_type": "salon", "duration_s": 6.0, "why": "Social proof without a fabricated testimonial."},
                {"shot": "Team moment between appointments", "footage_type": "bts", "duration_s": 8.0, "why": "Humanises the brand and supports community content."},
            ]},
        ],
        "total_estimated_minutes": 75,
        "covers_content_items": 12,
        "notes": (
            "Roughly 75 minutes of filming across the week yields raw material for about 12 content items. "
            "Film in landscape-safe vertical, keep the phone steady on a surface where possible, and always "
            "get explicit client consent before filming faces."
        ),
    }


def _story_sequence(prompt: str) -> dict[str, Any]:
    return {
        "day": "today",
        "frames": [
            {"index": 1, "category": "bts", "visual": "Salon opening, first client of the day", "text": "9AM. First chair of the day.", "interactive_prompt": None},
            {"index": 2, "category": "poll", "visual": "Split screen of two finishes", "text": "Which finish would you pick?", "interactive_prompt": "Glossy / Matte"},
            {"index": 3, "category": "tip", "visual": "Stylist holding a wide-tooth comb", "text": "Detangle from the ends up. Always.", "interactive_prompt": None},
            {"index": 4, "category": "before_after", "visual": "Today's transformation, split frame", "text": "Today's colour, start to finish.", "interactive_prompt": None},
            {"index": 5, "category": "cta", "visual": "Salon interior with clear type", "text": "Consultations available this week.", "interactive_prompt": None},
        ],
        "links_to_feed_topic": "balayage transformation reveal",
        "rationale": "Stories mirror the day's feed reel so the account reads as one coordinated day rather than disconnected fragments.",
    }


def _caption_set(prompt: str) -> dict[str, Any]:
    return {
        "hook_line": "Your hair isn't damaged because you use heat.",
        "variants": [
            {"label": "short", "body": "Your hair isn't damaged because you use heat.\n\nIt's damaged because of what you skip before it.\n\nSave this."},
            {"label": "medium", "body": "Your hair isn't damaged because you use heat.\n\nIt's damaged because of what happens before the heat — no protectant, sections that are too thick, and a dryer held too close.\n\nOur stylists talk through your routine before any treatment starts.\n\nSave this for your next appointment."},
            {"label": "long", "body": "Your hair isn't damaged because you use heat.\n\nHeat is a tool. Damage comes from how it's used — skipping protectant, drying sections that are far too thick, and holding the dryer close enough to overheat the cuticle.\n\nThe fix isn't giving up styling. It's three small changes:\n\n1. Protectant on damp hair, every time.\n2. Smaller sections — it's faster overall, not slower.\n3. Keep the nozzle moving and pointing down the hair shaft.\n\nWe'll walk through your routine at your next consultation.\n\nSave this so you have it when you need it."},
        ],
        "cta": "Save this before your next salon appointment.",
        "hashtags_broad": ["#haircare", "#hairtransformation", "#hairtips"],
        "hashtags_niche": ["#balayage", "#colourcorrection", "#keratintreatment", "#nanoplastia"],
        "hashtags_local": ["#jamshedpur", "#bistupur", "#jharkhand", "#salonjamshedpur", "#enrosesalon"],
        "alt_text": "A stylist demonstrating a blow-dry technique on sectioned hair in a salon.",
    }


def _command_plan(prompt: str) -> dict[str, Any]:
    # Read only the COMMAND block. The full prompt embeds the brand brain, which
    # names bridal services — matching against it would misroute every command.
    command = prompt
    marker = "COMMAND:"
    if marker in prompt:
        command = prompt.split(marker, 1)[1].split("\n\n", 1)[0]

    lowered = command.lower()
    if "campaign" in lowered or "bridal" in lowered:
        return {
            "understood_intent": "Create a bridal-season campaign: strategy, content pillars, ideas, calendar and drafts.",
            "clarifications": ["Which months should the bridal campaign cover?"],
            "steps": [
                {"order": 1, "action": "research_trends", "arguments": {"focus": "bridal"}, "rationale": "Establish which bridal formats are currently working before committing a calendar."},
                {"order": 2, "action": "create_campaign", "arguments": {"name": "Bridal Season"}, "rationale": "Group the work so its performance can be measured as a unit."},
                {"order": 3, "action": "generate_strategy", "arguments": {"emphasis": "bridal"}, "rationale": "Reweight pillars toward bridal planning and authority content."},
                {"order": 4, "action": "generate_calendar", "arguments": {"weeks": "4"}, "rationale": "Lay the campaign into dated slots."},
                {"order": 5, "action": "generate_content", "arguments": {"count": "6", "format": "reel"}, "rationale": "Produce the first wave of drafts for approval."},
                {"order": 6, "action": "generate_capture_checklist", "arguments": {}, "rationale": "Tell staff exactly what bridal footage to film this week."},
            ],
            "expected_outcome": "A dated bridal campaign with drafts queued for approval and a filming checklist for staff.",
        }
    return {
        "understood_intent": "Increase the viral potential of the next content cycle without abandoning business objectives.",
        "clarifications": [],
        "steps": [
            {"order": 1, "action": "analyze_performance", "arguments": {"days": "30"}, "rationale": "Identify which formats actually won before changing anything."},
            {"order": 2, "action": "research_trends", "arguments": {}, "rationale": "Find durable formats that fit the brand, not passing audio trends."},
            {"order": 3, "action": "adjust_strategy", "arguments": {"bias": "reach"}, "rationale": "Shift weight toward proven high-reach pillars, capped to avoid whiplash."},
            {"order": 4, "action": "generate_content", "arguments": {"count": "8"}, "rationale": "Generate against the updated strategy."},
        ],
        "expected_outcome": "An updated strategy weighted toward proven reach drivers, with fresh drafts generated against it.",
    }


FIXTURES: dict[str, Any] = {
    "brand_strategy": _brand_strategy,
    "trend_report": _trend_report,
    "competitor_report": _competitor_report,
    "content_strategy": _content_strategy,
    "reel_draft": _reel_draft,
    "carousel_draft": _carousel_draft,
    "story_sequence": _story_sequence,
    "caption_set": _caption_set,
    "virality_assessment": _virality_assessment,
    "qa_report": _qa_report,
    "performance_analysis": _performance_analysis,
    "learning_update": _learning_update,
    "footage_analysis": _footage_analysis,
    "capture_checklist": _capture_checklist,
    "command_plan": _command_plan,
    "comment_classification": {
        "classification": "booking_intent",
        "suggested_reply": "Thank you for reaching out — we'd love to help. Send us a DM and we'll find a time that suits you.",
        "requires_human": False,
        "reason": "Clear booking intent with no complaint or price question.",
    },
    "dm_classification": {
        "intent": "booking",
        "lead_intent": "high",
        "score": 88.0,
        "requested_service": "balayage",
        "suggested_reply": "We'd be glad to help with balayage. Let us check Saturday availability and come straight back to you.",
        "escalate": True,
        "reason": "Names a specific service and a specific date — highest-intent signal available.",
    },
}

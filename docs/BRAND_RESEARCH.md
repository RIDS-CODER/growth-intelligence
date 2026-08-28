# Enrose Salon — Brand Research Dossier

**Researched:** 2026-08-28
**Researcher:** automated web research pass (search-engine result summaries)
**Status of this document:** the *only* sanctioned source of brand facts for seeding the Brand Brain.

---

## 0. How to read this document

Every fact below carries a confidence label. The rule the whole system obeys:

| Label | Meaning | May the AI assert it publicly? |
|---|---|---|
| `VERIFIED` | Appeared in indexed public sources attributable to Enrose or a business directory listing Enrose. | Yes |
| `REPORTED` | Appeared in a third-party directory/aggregator but not confirmed against an Enrose-owned surface. | Only as soft framing; never as a claim of fact in a caption |
| `UNKNOWN` | Not obtainable in this environment. | **No.** Must be filled in by the client in the Brand Brain UI. |

`UNKNOWN` is a first-class value in the database — it is *not* a null to be quietly filled by a model.
See `docs/PRODUCT_SPEC.md` §Safety and `app/services/safety.py`.

### Research limitations in this environment (important, do not paper over)

- `https://www.enrosesalon.com/` and `https://www.instagram.com/enrosesalon` are **blocked by the session's
  network egress proxy**. They could not be fetched directly.
- Everything below therefore comes from **search-engine result summaries** that quote those pages, plus
  business-directory listings.
- Consequently **all Instagram account metrics are `UNKNOWN`**: follower count, posting cadence, historical
  engagement, top posts, current bio, and existing content patterns. Nothing about Enrose's *existing*
  Instagram performance is asserted anywhere in this system. The analytics engine begins with an
  honest cold start and fills in from the Instagram Graph API once credentials are connected.
- **No prices, no offers, no promotions, no testimonials, no review text, and no staff names were found,
  and none are recorded.** These are the highest-risk fabrication categories for a salon, and the QA agent
  hard-blocks any generated content that introduces them.

---

## 1. Identity

| Field | Value | Confidence |
|---|---|---|
| Business name | ENROSE SALON | `VERIFIED` |
| Website | https://www.enrosesalon.com/ | `VERIFIED` |
| Instagram | https://www.instagram.com/enrosesalon | `VERIFIED` |
| Self-description (site title) | "India's growing premium luxury salon \| Hair, skin, nails, bridal and spa" | `VERIFIED` |
| Positioning claim on site | "Jamshedpur's only premium luxury salon" | `VERIFIED` (self-asserted by the brand) |
| Category | Full-service premium salon (hair, skin, nails, bridal, spa) | `VERIFIED` |

> **Note on the positioning claim.** "Jamshedpur's only premium luxury salon" is a *brand-authored superlative*.
> The system stores it as a brand voice line, and the QA agent permits it only when it is attributed as the
> brand's own positioning — it will not let the AI invent adjacent superlatives ("the best", "#1 rated",
> "award-winning") that Enrose has not itself published.

## 2. Location and hours

| Field | Value | Confidence |
|---|---|---|
| City | Jamshedpur, Jharkhand, India | `VERIFIED` |
| Area | Bistupur | `VERIFIED` |
| Address | Contractors Area, Road No. 2, Bistupur, Jamshedpur | `REPORTED` (Welns booking directory) |
| Hours | Daily, 9:00 AM – 9:00 PM | `VERIFIED` |
| Walk-ins | "Walk-ins welcome Friday and Saturday" | `REPORTED` |
| Phone | — | `UNKNOWN` |
| Booking URL | — | `UNKNOWN` (a third-party booking listing exists on welns.io; not confirmed as the brand's canonical channel) |
| Additional branches | — | `UNKNOWN` — the site says "India's *growing*" premium luxury salon, which implies expansion intent but names no second location. Do not imply multiple branches. |

## 3. Services

All `VERIFIED` at the service-name level. **No price is known for any of them.**

**Hair**
- Haircuts by Style Directors and Senior Stylists (two stylist tiers — a real premium signal)
- Colour, balayage, highlights
- Texture / smoothing treatments: Nanoplastia, Keratin, Botox
- "Hair Rituals" by Kérastase

**Skin**
- Cleanups
- Advanced facials
- "Bioline skin rituals"
- Named tiers: Essential Cleanup, Signature Facial Advanced, HydraMemory

**Nails** — dedicated nail studio
- Gel extensions, acrylics
- Ombre, chrome, cat eye, custom nail art

**Spa**
- Swedish massage, Deep Tissue massage, Detox massage

**Bridal**
- Bridal makeup ("expert bridal makeup")

## 4. Product / brand partners

`VERIFIED`: Kérastase, Bioline, Cuccio, Blue Sky, Redken, L'Oréal Professionnel.

These are the only product brands the AI may name. The professional-brand roster is the strongest
objective evidence of premium positioning and is a legitimate, defensible content pillar
(product education, ritual explainers, "why professional colour differs").

## 5. Vocabulary the brand actually uses

Lifted from Enrose's own copy — this is the seed of the tone-of-voice model:

> "rituals" · "Hair Rituals" · "skin rituals" · "premium luxury" · "expert" · "Style Director" ·
> "Senior Stylist" · "Signature" · "Advanced"

The word **"ritual"** is doing real work here: Enrose frames services as *experiences*, not procedures.
The house style therefore leans experiential and unhurried, not discount-driven or urgency-driven.

## 6. Target audience (inferred — flagged as such)

Marked `INFERRED` in the Brand Brain, editable by the client, and never stated as fact in content:

- Women, roughly 22–45, in Jamshedpur and surrounding Jharkhand, with discretionary spend on appearance.
- Bridal clients and their families (bridal is a named service line and a high-ticket, highly seasonal segment).
- Professionals and business-family clientele in the Bistupur commercial district.
- Secondary: men's grooming — the site names haircuts but does not position a men's line; treat as `UNKNOWN`.

## 7. Competitive set (Bistupur / Jamshedpur)

Seeded as competitor *records to be monitored*, from directory listings. No engagement data — the
competitor analyst starts empty and populates as data is connected.

| Competitor | Type | Note | Confidence |
|---|---|---|---|
| Lakme Salon, Bistupur (Unite Mall) | National chain | Strongest brand-recognition competitor locally | `REPORTED` |
| The Jawed Habib Salon, Bistupur | National chain | H S Tower, L Road | `REPORTED` |
| Moraja – The Family Salon, Bistupur | Local unisex | Opposite Ram Mandir | `REPORTED` |
| Enrich Salons (Jamshedpur listings) | National chain | Presence indicated by directory listings | `REPORTED` |
| Sun Spa & Wellness Retreat | Local spa | Spa-led competitor | `REPORTED` |

**Strategic read:** Enrose's differentiators against chains are the *professional product roster*
(Kérastase / Bioline / Redken / L'Oréal Professionnel), the *stylist-tier system*, and the *ritual* framing.
Chains compete on price and familiarity. Enrose should not follow them there — the content strategy is
explicitly built to compete on craft and result quality instead.

## 8. Seasonal / local calendar hooks

Only *durable, publicly known* occasions are seeded. **No local event is ever fabricated** — the trend
agent may not invent a Jamshedpur-specific event, festival date, or venue.

Durable annual anchors relevant to an Indian salon:
Karwa Chauth · Navratri / Durga Puja (culturally major in Jharkhand/Bengal-adjacent regions) ·
Diwali · wedding season (roughly Nov–Feb and Apr–Jun) · New Year · Valentine's Day ·
monsoon haircare season (roughly Jun–Sep) · summer skin/sun season (Apr–Jun).

Anything more specific than this is `UNKNOWN` until the client confirms it.

## 9. What is deliberately absent

The following were **not found** and are recorded as `UNKNOWN` rather than guessed:

prices · packages · current offers or discounts · loyalty/membership programmes ·
stylist and team names · client testimonials or review text · star ratings and review counts ·
awards or certifications · founding year or founder story · phone number · email ·
canonical booking link · Instagram metrics of any kind · brand colour hex values ·
brand typefaces · logo file.

The Brand Brain UI surfaces every one of these as an explicit "needs client input" gap, with a
completeness score, because each unknown measurably narrows what the content engine may say.

---

## Sources

- [Enrose Salon — official site (indexed summary; direct fetch blocked)](https://www.enrosesalon.com/)
- [ENROSE SALON (@enrosesalon) — Instagram (direct fetch blocked)](https://www.instagram.com/enrosesalon/)
- [ENROSE SALON (Bistupur) — Welns booking listing](https://www.welns.io/product/booking/WFRCHN000024383/RegaliaWellness25483)
- [Lakme Salon, Bistupur — official salon page](https://salons.lakmesalon.in/lakme-salon-bistupur-unite-mall-jamshedpur-beauty-parlour-bistupur-jamshedpur-349822/Home)
- [The Jawed Habiib Salon, Bistupur — Justdial](https://www.justdial.com/Jamshedpur/The-Jawed-Habiib-Salon-Above-Fairdeal-Hyundai-Near-KVC-Mall-Bistupur/0657PX657-X657-210720185504-F2F7_BZDET)
- [MORAJA – The Family Salon, Bistupur — Justdial](https://www.justdial.com/Jamshedpur/MORAJA-THE-FAMILY-SALON-Opposite-Ram-Mandir-Bistupur/0657PX657-X657-170922185132-N7K1_BZDET)
- [Top Salons in Bistupur, Jamshedpur — Justdial](https://www.justdial.com/Jamshedpur/Salons-in-Bistupur/nct-10418299)

"""Deterministic safety scanner.

This is the authoritative fabrication check. It runs on every draft regardless of
what the QA agent said about itself, because a model's self-assessment is not
evidence — a rule violation cannot be argued away.

Cheap (pure regex and set membership) so it runs before and after generation with
no token cost.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, Literal

Severity = Literal["blocking", "warning"]


@dataclass
class Finding:
    rule: str
    severity: Severity
    detail: str
    excerpt: str


@dataclass
class ScanResult:
    findings: list[Finding] = field(default_factory=list)

    @property
    def blocking(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "blocking"]

    @property
    def passed(self) -> bool:
        return not self.blocking

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "findings": [
                {"rule": f.rule, "severity": f.severity, "detail": f.detail, "excerpt": f.excerpt}
                for f in self.findings
            ],
        }


# ── Rules ───────────────────────────────────────────────────────────────────
# Each is (name, severity, compiled pattern, human explanation).

_CURRENCY = re.compile(
    r"(₹\s?\d[\d,]*|\bRs\.?\s?\d[\d,]*|\bINR\s?\d[\d,]*|\$\s?\d[\d,]*|\b\d[\d,]*\s?(rupees|rs)\b)",
    re.IGNORECASE,
)
_DISCOUNT = re.compile(
    r"\b(\d{1,3}\s?%\s?(off|discount)|flat\s+\d+|half\s+price|buy\s+one\s+get|"
    r"limited\s+time\s+offer|special\s+offer|deal\s+of\s+the|coupon|promo\s?code|"
    r"lowest\s+price|starting\s+(at|from)\s+\S*\d)\b",
    re.IGNORECASE,
)
_MEDICAL = re.compile(
    r"\b(cure[sd]?|treats?\s+(acne|eczema|psoriasis|alopecia)|heals?|"
    r"clinically\s+proven|dermatologist\s+(approved|recommended)|medically|"
    r"prescription|therapeutic|reverses?\s+(hair\s+loss|ageing|aging)|"
    r"regrow(s|th)?\s+hair|permanent(ly)?\s+(remove|straighten|cure))\b",
    re.IGNORECASE,
)
_GUARANTEE = re.compile(
    r"\b(guarantee[ds]?|100%\s+(safe|effective|results)|no\s+side\s+effects|"
    r"risk[-\s]free|results?\s+in\s+\d+\s+(days?|weeks?)|instant(ly)?\s+(fix|repair))\b",
    re.IGNORECASE,
)
_SUPERLATIVE = re.compile(
    r"\b(best\s+(salon|in\s+town|in\s+the\s+city)|#\s?1\b|number\s+one\s+salon|"
    r"award[-\s]winning|top[-\s]rated|voted\s+best|india'?s\s+best|world[-\s]class)\b",
    re.IGNORECASE,
)
_TESTIMONIAL = re.compile(
    r"(\"[^\"]{15,}\"\s*[-–—]\s*[A-Z][a-z]+|our\s+clients?\s+say|"
    r"\b\d(\.\d)?\s?(star|★)\s?(rating|reviews?)|rated\s+\d(\.\d)?\s?/\s?5)",
    re.IGNORECASE,
)

_RULES: list[tuple[str, Severity, re.Pattern[str], str]] = [
    ("invented_pricing", "blocking", _CURRENCY,
     "Contains a currency amount. No prices are recorded in the Brand Brain, so any price here is fabricated."),
    ("invented_offer", "blocking", _DISCOUNT,
     "Contains discount or offer language. No offers are recorded in the Brand Brain."),
    ("medical_claim", "blocking", _MEDICAL,
     "Contains a medical, clinical or therapeutic claim. A salon may not make these."),
    ("guarantee_claim", "blocking", _GUARANTEE,
     "Contains a guarantee or promised outcome/timeframe."),
    ("fabricated_testimonial", "blocking", _TESTIMONIAL,
     "Appears to contain a client testimonial, quote or rating. None are recorded in the Brand Brain."),
    ("unverified_superlative", "warning", _SUPERLATIVE,
     "Contains a superlative claim. Only permitted if the brand publishes that claim itself."),
]


def _excerpt(text: str, match: re.Match[str], width: int = 60) -> str:
    start = max(0, match.start() - width // 2)
    end = min(len(text), match.end() + width // 2)
    return ("…" if start > 0 else "") + text[start:end].strip() + ("…" if end < len(text) else "")


def scan_text(
    text: str,
    *,
    known_services: Iterable[str] = (),
    known_products: Iterable[str] = (),
) -> ScanResult:
    """Scan a block of generated copy for fabrication risks."""
    result = ScanResult()
    if not text:
        return result

    for rule, severity, pattern, detail in _RULES:
        for match in pattern.finditer(text):
            result.findings.append(
                Finding(rule=rule, severity=severity, detail=detail, excerpt=_excerpt(text, match))
            )
            break  # one finding per rule is enough to block; don't flood the report

    # Product brands: naming a brand the salon does not carry is a fabrication, and
    # it is the single most likely one for a beauty model to produce.
    known_lower = {p.lower() for p in known_products}
    if known_lower:
        for competitor_brand in _COMMON_BEAUTY_BRANDS:
            if competitor_brand.lower() in known_lower:
                continue
            if re.search(rf"\b{re.escape(competitor_brand)}\b", text, re.IGNORECASE):
                result.findings.append(
                    Finding(
                        rule="unknown_product_brand",
                        severity="blocking",
                        detail=(
                            f"Names '{competitor_brand}', which is not in the Brand Brain's product list. "
                            "Only brands the salon actually carries may be named."
                        ),
                        excerpt=competitor_brand,
                    )
                )

    return result


# Brands a beauty-domain model is likely to reach for. Naming one the salon does not
# carry is a concrete, checkable fabrication.
_COMMON_BEAUTY_BRANDS = [
    "Olaplex", "Wella", "Schwarzkopf", "Matrix", "TRESemmé", "Dove", "Head & Shoulders",
    "Moroccanoil", "Davines", "Aveda", "GHD", "Dyson", "Living Proof", "Pureology",
    "Joico", "Goldwell", "Revlon", "Garnier", "Streax", "Godrej", "Biolage",
]


def scan_content_item(payload: dict, *, known_services=(), known_products=()) -> ScanResult:
    """Scan every text-bearing field of a generated content payload."""
    chunks: list[str] = []

    def collect(value: object) -> None:
        if isinstance(value, str):
            chunks.append(value)
        elif isinstance(value, dict):
            for v in value.values():
                collect(v)
        elif isinstance(value, list):
            for v in value:
                collect(v)

    collect(payload)
    return scan_text(
        "\n".join(chunks), known_services=known_services, known_products=known_products
    )

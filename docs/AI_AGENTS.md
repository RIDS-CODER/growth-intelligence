# AI Agent Architecture

14 single-purpose agents. No monolithic prompt. Each agent is a small module with one job, one prompt
builder, one Pydantic output schema, and one model tier.

## Anatomy of an agent

```python
class ReelWriter(Agent[ReelDraft]):
    name         = "reel_writer"
    output_model = ReelDraft          # Pydantic v2 → JSON Schema → forced tool use
    tier         = ModelTier.BALANCED # → settings.model_for(tier)
    system       = prompts.reel.SYSTEM

    def build_user_prompt(self, ctx: GenerationContext) -> str: ...
```

The base runtime (`app/agents/base.py`) then handles, identically for every agent:

- brand-brain context assembly with `UNKNOWN` fields rendered explicitly
- cacheable system prefix for the stable brand block
- forced tool-use call so output is a typed object, never prose
- Pydantic validation, with **one** repair retry that feeds the validation errors back
- token, cache-hit, latency and USD cost accounting
- a row in `ai_activity_log` on both success and failure
- provider-agnostic execution: `AnthropicProvider` or `MockProvider`, same code path

---

## 1. Brand Strategist — `brand_strategist`
**Tier:** strong · **Out:** `BrandStrategy`

Owns the Brand Brain. Turns raw brand facts into positioning, audience segments, tone rules, visual
direction and strategic objectives. Explicitly reasons about confidence: it must return `UNKNOWN` for
anything the dossier does not support, and it emits `information_gaps` — the questions the client must
answer to unlock better content. It is the only agent allowed to *propose* content pillars.

## 2. Trend Researcher — `trend_researcher`
**Tier:** balanced · **Out:** `TrendReport`

Produces structured trend intelligence across Instagram formats, beauty/hair/nail/salon trends, seasonal
and festival opportunities. Each trend carries category, popularity indicator, relevance-to-Enrose score,
expiry probability, a recommended adaptation, and status.

The gate that matters: **"can this trend naturally fit Enrose?"** If no, the trend is stored with
`recommended_action = "ignore"` and a reason. It is never force-fitted. The agent may not invent local
events — a Jamshedpur-specific event must be client-supplied or omitted.

## 3. Competitor Analyst — `competitor_analyst`
**Tier:** balanced · **Out:** `CompetitorReport`

Per competitor: posting frequency, formats, topics, hooks, engagement signals, visual style, offers
observed. Its actual output is the **gap analysis** — the angles the competitive set is not covering that
Enrose's product roster and stylist-tier system uniquely qualify it to own. Copying is an explicit
anti-goal stated in the prompt; differentiation is the objective.

## 4. Content Strategist — `content_strategist`
**Tier:** strong · **Out:** `ContentStrategy`

The cycle planner. Decides pillar mix and weights, posting frequency, format split, objectives, audience
segments, and the themes for the period. Prioritises against five weighted axes:

1. business value · 2. audience relevance · 3. historical performance · 4. trend potential · 5. brand fit

Reach is deliberately *not* the objective function. A bookings-driven salon that optimises for views
produces viral content that sells nothing, and the prompt says so.

## 5. Reel Writer — `reel_writer`
**Tier:** balanced · **Out:** `ReelDraft`

Full production-ready reel: concept, hook, the first-three-seconds beat, script, numbered shot list,
on-screen text, optional voiceover, editing instructions, b-roll requirements, CTA, caption, hashtag
groups, cover/title text, objective. Written so a salon employee with a phone can shoot it without
further interpretation.

## 6. Carousel Writer — `carousel_writer`
**Tier:** balanced · **Out:** `CarouselDraft`

Cover plus 4–9 slides. Per slide: headline, body, visual instruction, and a template key that maps to a
real render template in `services/render_templates.py`. Ends on a CTA slide.

## 7. Story Writer — `story_writer`
**Tier:** cheap · **Out:** `StorySequence`

Daily story sets across poll / question / quiz / before-after / product / tip / CTA / testimonial / BTS /
offer / interactive. Stories are generated *bound to the day's feed post* (`linked_content_item_id`) so the
account reads as one coordinated day rather than disconnected fragments.

## 8. Caption Writer — `caption_writer`
**Tier:** cheap · **Out:** `CaptionSet`

Three caption variants at different lengths, hook line, CTA, hashtag groups (broad / niche / local),
and alt text. Separate from the reel/carousel agents so captions can be regenerated cheaply without
re-running an expensive creative pass.

## 9. Virality Scorer — `virality_scorer`
**Tier:** balanced · **Out:** `ViralityAssessment`

Scores 12 dimensions 0–100 with a written rationale for each:

> hook strength · curiosity · emotional response · shareability · saveability · rewatch potential ·
> relatability · trend alignment · visual transformation · audience relevance · brand fit · conversion potential

The model supplies sub-scores and reasoning. The **roll-up is deterministic Python**
(`services/virality.py`): the first eight roll into the viral score, the last four into the business score,
and the overall is a configurable 50/50 blend. Keeping the arithmetic out of the model makes scores
comparable across time and immune to drift — a 78 in March means the same thing as a 78 in September.

Also returns `predicted_top_percentile`, the single biggest weakness, and a concrete fix.

## 10. QA Reviewer — `qa_reviewer`
**Tier:** balanced · **Out:** `QAReport`

Runs before anything reaches the client. Checks brand consistency, grammar, factual accuracy,
hallucinated claims, invented pricing, unsupported medical/beauty claims, tone, CTA quality, hook
strength, repetition against content memory, visual consistency, and platform compliance.

Returns per-check pass/fail with severity. **Any `blocking` finding auto-rejects the draft** and it never
reaches the approval queue. This agent runs *alongside* the deterministic scanner in `services/safety.py`
— the rule scanner is authoritative and cannot be overridden by the model's opinion of itself.

## 11. Performance Analyst — `performance_analyst`
**Tier:** strong · **Out:** `PerformanceAnalysis`

The agent that makes the product feel like a hire rather than a tool. It is contractually forbidden from
restating raw metrics. Every finding must be **comparative and causal**:

> ❌ "Reel got 20,000 views."
> ✅ "Transformation reels generated 2.4× the average reach of promotional reels over the last 30 days —
>    driven by strong visual payoff in the first two seconds and a 3.1× save rate. Recommendation:
>    increase transformation content by 25% next cycle."

Output: findings (each with evidence, magnitude, confidence, and a why), what to do more of, less of,
what to stop, and explicit strategy deltas as machine-applicable numbers.

## 12. Learning Agent — `learning_agent`
**Tier:** strong · **Out:** `LearningUpdate`

Converts analysis into durable memory. Writes `brand_memory` insights with evidence, confidence and an
expiry date, supersedes contradicted prior insights, and emits bounded pillar-weight deltas. Guardrails
live in the service, not the prompt: a single cycle may not shift any pillar weight by more than a
configured cap, so one lucky viral reel cannot hijack the whole strategy.

## 13. Footage Analyst — `footage_analyst`
**Tier:** balanced · **Out:** `FootageAnalysis`

The raw-footage engine, and the thing that makes this practical for a real salon. Given the clips staff
actually uploaded (each tagged: before / wash / cut / colour / styling / after / reaction / detail / BTS),
it recommends which reel to build, the optimal clip sequence with cut points, hook, text overlays, music
direction, caption and CTA.

Critically it also returns **`missing_shots`** — what to film next time and why it matters:

> "Good transformation footage detected. Missing: client reaction, final close-up, stylist reveal.
>  Shoot next: (1) 3s final hair shot, (2) client mirror reaction, (3) stylist smiling reveal."

It reports a `completeness` score, so staff know whether a shoot is finished before the client leaves —
which is the difference between usable footage and a wasted appointment.

## 14. Command Center — `command_center`
**Tier:** strong · **Out:** `CommandPlan`

The natural-language interface. "Create a campaign for bridal season." / "Make next month's content more
viral." It interprets intent, asks **only** genuinely blocking questions (`clarifications`), then emits an
ordered plan of typed steps the orchestrator actually executes against real services — not a description
of what someone could do. Each step names its agent/service, arguments, and rationale.

---

## Phase 3 agents (interfaces defined, implementations deferred)

- **Comment Classifier** — positive / question / price request / booking intent / complaint / spam /
  negative / needs-human, with a suggested reply. Complaints and negative sentiment are **never**
  auto-answered; they escalate to a human by policy in the service layer, not by prompt convention.
- **DM Classifier** — intent extraction and lead scoring. High-intent leads ("I want to book balayage
  Saturday") raise a `HIGH_INTENT` lead alert to staff.

## Prompt module layout

```
app/prompts/
  brand_strategy.py   trend_research.py     competitor_analysis.py
  content_strategy.py reel.py               carousel.py
  story.py            caption.py            virality.py
  qa.py               analytics.py          learning.py
  footage.py          command.py            shared.py   ← brand block, safety preamble, memory block
```

`shared.py` holds the three fragments composed into most prompts: the rendered brand brain (with
`UNKNOWN` handling), the non-negotiable safety preamble, and the learned-insight block. Changing the
safety rules is therefore a one-file change that propagates to every agent at once.

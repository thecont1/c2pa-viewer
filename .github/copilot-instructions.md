## Design Context

### Users
The general public first — anyone asking "is this image real?" Their context is
often a moment of doubt: a suspicious image in a feed, a photo they need to
trust, a quick check before sharing. The job to be done is a fast, legible
verdict — not a forensic report they must interpret. Developers and newsroom
verifiers are the secondary audience, served by the API surface and dashboard,
but the design language must never exclude the lay user. Emotions to evoke:
confidence in the verdict, vigilance without alarm, sharpness without noise.

### Brand Personality
**Bold, vigilant, sharp** — watchdog energy. The product is actively hunting
fakes on the user's behalf, not passively reporting metadata. Voice: direct,
plain-spoken, unafraid of plain verdicts ("camera-signed", "AI-generated",
"no credentials found"). Never hype, never hedged corporate softness — the
honesty already present in the docs (retention targets, TLS disclosure) is a
brand trait, not a liability.

### Aesthetic Direction
Keep the Material-inspired neutral canvas (light `#f8f9fa` surfaces, `#202124`
text, Inter + mono) — but it is a *canvas*, not the personality. Boldness comes
from verdict presentation: strong status badges, decisive color for trust
states (green = verified/trusted, orange = AI-generated, red = invalid/missing),
sharp typography for the headline answer. Anti-references: crypto-scam
dark-neon, SaaS-gradient purple, playful-consumer pastel. This is an instrument,
not a lifestyle brand — but an instrument that speaks loudly when it has an
answer.

### Design Principles
1. **Verdict first, evidence second** — the headline answer in bold type and
   decisive color; supporting detail collapses beneath it. Lay users get the
   answer; experts unfold the proof.
2. **Bold on a quiet canvas** — neutral grays and white space everywhere except
   trust-state moments, which carry the full chromatic weight. Color is
   reserved for meaning, never decoration.
3. **Honest states, never cosmetic ones** — badges and status must reflect the
   real verification outcome exactly; no optimistic greenwashing of "unknown"
   or "unsigned".
4. **Both modes, AA minimum** — light and dark themes with WCAG AA contrast on
   every trust-state color pair; color never the sole carrier of meaning
   (icon + label always).
5. **Calm motion** — functional transitions only, and everything honors
   `prefers-reduced-motion`; a verification instrument does not perform.

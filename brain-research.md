# My Brain — Research Review

**Are we doing it right?** A research review of the My Brain Lab / Situation (Goal → Blocker → Lever) / Mentor model — where it's grounded in science, where it's risky, what the competition teaches, and what we changed.

By Sandeep Karnati · June 2026 · sources linked inline · live version: https://mybrain.1site.ai/research.html

---

## The verdict

The core idea is more validated than you'd expect for something built on intuition.

- **✓ On solid ground** — Goal → Blocker → Lever maps almost one-to-one onto Theory of Constraints, GTD next-actions, and implementation intentions. The ✓/✗ trust loop is genuinely ahead of the field.
- **⚠ The risk** — it isn't the model, it's the nightly "here's what I noticed about you" + nudging layer. That's exactly where this category backfires: surveillance-feel, shame, nudge fatigue.
- **→ Mostly framing** — most fixes are wording and cadence, not rebuilds: compassion over scoreboard, pull over push, humble over confident, dynamic over set-once.

---

## The science

1. **Goal → Blocker → Lever = Theory of Constraints.** Goldratt's thesis: every system has one dominant constraint, and the highest-leverage move is to find it and "exploit" it before anything else. Your *Blocker* is the constraint; your *Lever* is the exploit. "Plan around the lever, not the blocked goal" is literally ToC's *Subordinate* step. Caveat (ToC's own): once a lever moves, the constraint *shifts* — so a set-once Situation goes stale; ToC says "Repeat." — https://www.tocinstitute.org/five-focusing-steps.html
2. **"Lever-moving next action" = GTD's strongest idea.** Every item reduces to "the next physical, visible activity." Reducing a blocker to one concrete action bypasses decision fatigue, and the psychology is real — cognitive offloading + the Zeigarnik effect mean a concrete plan releases the mental load even before you act. — https://super-productivity.com/blog/gtd-next-actions-guide/
3. **"If-then" plans = the single best-evidenced lever (d ≈ 0.65).** Implementation intentions ("If X, then I'll do Y") are one of the most replicated effects in behaviour-change science — a meta-analysis of 94 tests found d = 0.65 over goal intentions alone, confirmed by a 2024 update of 642 tests. Best when contingent, motivated, and rehearsed once. — https://pmc.ncbi.nlm.nih.gov/articles/PMC8149892/
4. **A small action when stuck = Behavioural Activation.** BA disrupts avoidance by scheduling a small approach-action *in the presence of* the bad mood. A NICE first-line treatment with effects rivalling full CBT. Validates our philosophy: when someone's avoiding, give a small concrete action, not analysis. — https://www.frontiersin.org/journals/psychiatry/articles/10.3389/fpsyt.2022.845138/full
5. **"Plan with you, don't nag" = Motivational Interviewing + Self-Determination Theory.** Change sticks when it's autonomous — the person owns it. MI evokes the person's own reasons rather than pressuring; SDT shows autonomy-supportive framing drives durable change. The Mentor's tone is right; the danger is the nudge layer flipping it from "yours" to "pressured." — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3330017/
6. **Anchor levers to a daily cue (and never punish a missed day).** Lally et al. (UCL): habits form by repeating a behaviour in a consistent context (median ~66 days), and missing one day doesn't break it. So anchor lever-actions to existing cues, and never streak-shame. — https://onlinelibrary.wiley.com/doi/10.1002/ejsp.674

---

## The AI side

1. **LLM-inferred personality is only modestly accurate — and over-confident.** LLM-to-self-report trait correlation is around r = 0.29 — useful, not authoritative — and benchmarks find systematic over-confidence and poor calibration. So findings must be framed as hypotheses ("I'm noticing… does this ring true?"), never asserted. Our trust ladder + ✓/✗ is the right instinct; keep the language humble. — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11211928/
2. **Our memory pattern matches best practice.** The current agent-memory playbook (Mem0, MemGPT/Letta): extract facts not raw text → consolidate (add/update/delete) → reflect. The Lab already does this. The known risk is compounding error from probabilistic extraction — which is why the human ✓/✗ loop matters. — https://mem0.ai/blog/long-term-memory-ai-agents
3. **Trust calibration: show confidence + "why I think this" + easy correction.** Explanations that reveal limitations (not persuade), visible confidence, and easy correction are what turn an AI claim from creepy into trustworthy. We already show evidence + the trust ladder + ✓/✗/note. — https://pmc.ncbi.nlm.nih.gov/articles/PMC7660448/
4. **Sycophancy — the agreeable-AI trap.** OpenAI rolled back an April 2025 GPT-4o update for being too flattering. An AI that only validates is *worse* for growth. A coaching product differentiates with honest, evidence-grounded push-back, not agreement. — https://spectrum.ieee.org/ai-sycophancy

---

## Competitors

- **Replika — memory is the moat *and* the liability.** 30M+ users love that it "remembers things I can't even remember," but the 2023 feature change had users calling their companion "lobotomized," and memory failures + Mozilla's "Privacy Not Included" verdict are recurring wounds. Lesson: durable, user-owned memory is the #1 trust promise — and forced model changes are catastrophic. — https://www.thebrink.me/ai-companion-grief-chatbot-update-mental-health/
- **Dot (New Computer) — presented inferences as facts, no correction loop.** Built a "living mirror of yourself," won design praise, but stated inferences *as confident facts* (a false "morning hike") with no surfaced way to correct them, and shut down Oct 2025. Its antidote to creepiness was grounding memory in things you *made together*. Lesson: our ✓/✗ loop is precisely the gap Dot left open. — https://techcrunch.com/2025/09/05/personalized-ai-companion-app-dot-is-shutting-down/ · https://diklein.com/on-the-design-of-dot/
- **Day One — the journaling leader, and "keep AI out of my journal."** 4.8★, beautiful, E2E-encrypted — but its 2026 AI push hit a wall ("I do not want to give my very private data to LLM providers"), and its docs admit content is "temporarily not end-to-end encrypted" during AI processing. Top trust-killer is actually sync data-loss, plus a $74.99 AI tier. — https://forums.dayoneapp.com/forums/topic/please-keep-ai-out-of-day-one/
- **Atoms (Atomic Habits) — identity is user-declared, never inferred.** James Clear's app uses "I will [habit] so I become [type of person]" — but the user *declares* the identity; the app never infers "you're the type of person who…". The team that invented identity-based habits chose *not* to reflect an inferred self. So our inferred-self reflection is a real differentiator — and exactly why it needs hedging + correction. — https://www.entrepreneur.com/business-news/james-clears-atoms-app-helps-build-atomic-habits/473491
- **Mem / Reflect / Saga — "a search bar, not a brain."** The complaint converges: "if your AI second brain says the same generic thing in week 12 that it said in week 1, it isn't a brain — it's a search bar over your notes." The opening: insight that compounds and gets specific. — https://vectorize.io/articles/ai-second-brain-that-learns
- **Rosebud / Reflectly — the weekly digest is loved; the nagging is hated.** Rosebud's most-praised feature is a weekly email of patterns + wins. But insights "converge after 8–10 entries," and Reflectly users report being "constantly bugged with upgrade notifications." Borrow the weekly digest; avoid the convergence + nagging. — https://www.reflection.app/blog/ai-journaling-apps-compared
- **Spotify Wrapped — how to make "here's who you are" feel good.** Wrapped turns inference into a celebratory archetype ("there's no wrong way to listen"). But 2024's AI recap broke the spell — generic, "soulless," oddly-specific-but-wrong ("Pink Pilates Princess"). Lesson: accuracy is load-bearing; specific-and-wrong is worse than vague-and-true; never let it feel commercial. — https://several.com/news/spotify-wrapped-2024-backlash

---

## Market traps (cross-cutting)

1. **Retention — the habit almost never forms.** Median 15-day retention for mental-health apps is ~3.9%; ~77% are gone within 3 days. People quit because the habit never forms, journaling tips into rumination, or blank-page pressure. The industry's "fix" (more notifications) feeds the next trap. — https://www.amraandelma.com/mobile-app-retention-statistics/
2. **"AI insights feel generic" — the #1 complaint.** Apps converge on validate → reframe → action and stop feeling personal; 84% who left Rosebud cited "depth of AI responses." The differentiator is memory of *your* specifics, not generic empathy. — https://blog.mylifenote.ai/rosebud-journal-alternative/
3. **Privacy — people self-censor, so insights stay shallow.** Journaling only works if you're brutally honest — but honesty is what people withhold once a cloud LLM is in the loop. Privacy is a product-efficacy lever, not a checkbox. — https://www.pausa.co/blog/common-privacy-issues-in-ai-journaling
4. **Sycophancy — comfort over candor harms growth.** An AI that only agrees is optimised for thumbs-up, not growth. Coaching value is in the friction. — https://mindsitenews.org/2025/10/22/the-problem-with-chatgpt-therapy/
5. **Notification + paywall fatigue.** Guilt-trip notifications backfire ("a MEDITATION app was stressing me out. I uninstalled it"), and mental-health paywalls draw uniquely intense resentment. The streak mechanic meant to drive retention is what drives the uninstall. — https://unstar.app/blog/mental-health-app-reviews-what-users-say-about-wellbeing-apps-2026

---

## Where My Brain is different

- **The ✓/✗ trust loop is genuinely ahead of the field.** ChatGPT and Dot mostly *assert* what they infer. Almost nobody lets you validate or reject an inferred trait with the evidence attached — the textbook antidote to both the "creepy line" and "generic insights."
- **The Situation model is more actionable than "validate → reframe."** Everyone else's loop ends at a reflection. Goal → Blocker → Lever ends at the one thing to actually do — grounded in real frameworks (ToC + GTD), not therapy-speak.
- **Learns from CLOSED days, not nightly nagging.** The Lab reflects when *you* close a day, sidestepping the notification-fatigue trap.
- **Privacy is already in our bones.** Self-hosted with a zero-knowledge Vault — the "your data, actually private" story the category is missing. We just needed to say it loudly.

---

## What we changed (shipped)

The four core changes from this research, plus three follow-ups — all live.

- **BEA-524 — If-then lever actions.** Levers and suggested tasks are now phrased as "When `<daily cue>`, I'll `<one action>`" (implementation intentions, d ≈ 0.65).
- **BEA-525 — Compassion, not a scoreboard.** The Mentor and Lab name avoidance/draining patterns kindly — assume a real reason, pair with one small next step, never shame.
- **BEA-526 — Dynamic Situation.** When a day closes, the Lab re-checks each active blocker (held / shifted / resolved) — ToC's "Repeat" — with a gentle "did your blocker shift?" prompt.
- **BEA-527 — Insights pull, not push.** Telegram nudges (nightly Mentor note + morning story reminder) are now optional toggles; notes always wait in-app; never streak-shame.
- **BEA-528 — Story of the Week.** The weekly review now surfaces one fresh, specific thing the Lab is learning about you.
- **BEA-529 — Privacy headline page.** A loud, plain privacy promise (mybrain.1site.ai/privacy.html), linked from Settings.
- **BEA-530 — Productive-friction Mentor.** The Mentor can respectfully push back when your read of a day doesn't match the data — coach, not cheerleader.

---

*Sources are linked inline. The interactive version of this review lives at https://mybrain.1site.ai/research.html.*

# LN Filter v0.6 — "Rank-then-Show, Reload-Resilient"

Status: **draft spec** · Target version: `0.6.0` · Builds on: `0.5.3` (must be verified stable first)

---

## 1. Motivation

v0.5.x is **reactive**: LinkedIn renders a post, *then* we score and hide/dim it.
That produces the visible failure modes the user reported:

- **In-view evaluation jump** — a post shows, gets scored, and collapses (`display:none`)
  while you're looking at it → the feed lurches.
- **Load cascade** — hiding shrinks the feed column → LinkedIn's infinite scroll loads
  another batch → more posts to score → more hiding → … (amplified the 429 error storm).
- **Reload churn** — LinkedIn auto-refreshes the feed on tab **re-focus** and on its own
  idle timer; every refresh re-renders the DOM and (pre-0.5.3) orphaned all tracking.

v0.6 flips the model to **rank-then-show**: a post is held until it has a rank, then
revealed already-filtered. The user never watches a post collapse.

### Explicit non-goal — full network/render takeover
We will **not** intercept Voyager/GraphQL responses and render our own feed. We cannot
feed filtered data back into LinkedIn's own renderer (it draws from its internal store),
so "owning" the pipeline would mean reimplementing LinkedIn's entire post UI and chasing
their API forever — massive, brittle, and against ToS. v0.6 stays a DOM overlay; it only
changes *when* posts become visible.

---

## 2. Post lifecycle (HIDE mode)

```
            discover (DOM insert / scan)
                      │
                      ▼
              ┌───────────────┐   cache hit / score ≥ threshold
   gate it →  │   GATED        │ ─────────────────────────────► REVEALED (shown)
 (display:none)│ (held hidden) │
              └───────────────┘   score < threshold
                  │   │  └──────────────────────────────────► FILTERED (stays hidden)
                  │   └──── scoring error / gate timeout ────► REVEALED (fail-open)
                  │
      gate budget exceeded → show ungated (reactive fallback), score normally
```

- **DIM mode is unchanged.** It is already smooth (opacity, no collapse). Gating applies
  only to HIDE mode. This is the recommended low-cost default.
- **Fail-open everywhere:** if we can't rank a post (error, timeout, budget), we **show**
  it. We never trap content we failed to evaluate.

---

## 3. Subsystems

### A. Reveal gating (`hold-until-ranked`)
**Goal:** no post ever flashes-then-collapses in view.

- On discovery in HIDE mode, if the post has no score yet: add class `lnf-gate`
  (`display:none`). Apply on the **layoutEl** (the resolved real box from 0.5.3).
- Apply the gate as early as possible to avoid a paint flash:
  - MutationObserver childList callback (fires before paint in most cases), **and**
  - the 4 Hz scanner re-applies it (React strips classes — same resilience pattern we
    already use for `lnf-post`).
- Resolve:
  - score ≥ threshold → remove `lnf-gate` → **reveal**.
  - score < threshold → remove `lnf-gate`, add `lnf-hidden` → **filtered** (stays hidden,
    no separate collapse because it was never shown).
  - error → remove gate → **reveal** (fail-open).
- **Gate budget** (`gateBudget`, default **12**): cap concurrently-gated posts. Past the
  cap, new posts are shown ungated and scored reactively. Prevents the gate itself from
  shrinking the column without bound (the cascade the user identified).
- **Gate timeout** (`gateTimeoutMs`, default **6000**): a gated post not resolved in time
  is force-revealed. Never trap content behind a stalled queue.

**Edge cases**
- Threshold/mode change while posts are gated → re-evaluate all gated posts immediately.
- A gated post scrolls into view still unresolved → it simply isn't there yet; on resolve
  it pops in at/below the fold (no above-fold shift). With look-ahead this is rare.

### B. Look-ahead pre-scoring
**Goal:** rank posts before they reach the viewport so reveals happen ahead of the scroll.

- Keep a window of `lookahead` (rename/keep `bulkLookahead`, default **30**) unscored posts
  **below the fold** queued for scoring, ordered by DOM position.
- Prioritization order in the queue: (1) gated posts in/near viewport, (2) below-fold within
  lookahead window, (3) everything else.
- Depends entirely on **reliable observation** → the 0.5.3 re-observe fix is the prerequisite.

### C. Cascade control (backoff + budget) — *do regardless, it's strictly better*
**Goal:** the "thousands of errors" / 429 storm can never recur.

- Keep concurrency cap (existing, default 4).
- **429 handling:** on rate-limit, exponential backoff **and** a global queue pause for
  `cooldownMs` (default **30000**). Do not enqueue new work during cooldown.
- **Quiet logging:** collapse repeated identical failures into one warning + a count; never
  emit one red error per retry. Surface a single overlay status ("rate-limited, paused 30s").
- **Optional scoring cap** (`maxScoresPerMin`, default **0 = off**): soft rate limiter with
  overlay indicator, for users on tight free-tier quota.

### D. Reload resilience
**Goal:** survive LinkedIn's focus/idle auto-refresh cheaply and invisibly.

- **`visibilitychange` / `focus` listener** → force an immediate re-scan + re-apply so the
  re-rank snaps back the moment you tab in, instead of waiting for the mutation observer.
- Rely on existing machinery that already makes this cheap:
  - Stable post id = `fnv1a(author|text)` → same post → same id across re-renders.
  - **Score cache in the service worker** (24 h) → re-scoring after a reload is a **cache
    hit**, zero new Gemini calls. *This is what prevents a refocus from triggering a 429
    storm.*
  - 0.5.3 re-observe → re-attach to freshly-rendered nodes (no orphaning).
- On reload, gated+cache-hit posts reveal **already-ranked** (instant). New uncached posts
  gate normally.

---

## 4. Settings additions

| Key | Default | Meaning |
|-----|---------|---------|
| `gateBudget` | 12 | Max concurrently-gated (held) posts before falling back to reactive. |
| `gateTimeoutMs` | 6000 | Force-reveal a gated post not resolved in time. |
| `lookahead` (was `bulkLookahead`) | 30 | Below-fold posts to pre-score. |
| `cooldownMs` | 30000 | Global pause after a 429. |
| `maxScoresPerMin` | 0 | Optional soft rate cap (0 = off). |

All additive; existing settings and the `DEFAULT_SETTINGS` merge stay backward-compatible.

---

## 5. CSS (`content/overlay.css`)

```css
/* Held until ranked — applied the instant a post is discovered in HIDE mode. */
.lnf-gate { display: none !important; }
```

(Keep `.lnf-hidden` / `.lnf-dimmed` as-is. `.lnf-gate` and `.lnf-hidden` are functionally
identical CSS but kept distinct so diagnostics can tell "held, awaiting rank" from
"ranked and filtered out".)

---

## 6. Diagnostics / overlay

- `__lnfDiag()` adds: `gated`, `revealed`, `filtered`, `rateLimited`, `cooldownUntil`.
- Overlay status line: `N rated · M held · K hidden` and a rate-limit badge when paused.
- Service-worker log: one line per batch + a single throttled warning per 429 episode
  (not per retry).

---

## 7. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Gate paint-flash (observer lags paint) | Gate in mutation callback **and** 4 Hz scanner; CSS is `!important`. |
| React strips `lnf-gate` | Re-apply every scan tick (existing pattern for `lnf-post`). |
| Good content trapped behind stalled queue | `gateTimeoutMs` fail-open + fail-open on error. |
| Cascade from gating shrinking the column | `gateBudget` cap → reactive fallback past the cap. |
| 429 storm | Cooldown pause + quiet logging + optional `maxScoresPerMin`. |
| Refocus re-score cost | SW cache hit (stable hash); only genuinely new posts cost calls. |

---

## 8. Rollout & verification (one subsystem at a time, verify each on a clean reload)

0. **Pre-req:** 0.5.3 verified stable (auto-scoring, no error storm, hide sticks).
1. **D (reload resilience)** first — smallest, derisks the environment. Verify: tab out/in,
   feed re-ranks from cache with no new API calls (watch SW log).
2. **C (backoff + quiet logging)** — verify: force 429s (low quota), confirm one warning +
   pause, no red flood.
3. **A (gating)** behind a flag — verify: scroll through HIDE mode, **no in-view collapse**;
   gate budget caps held count; timeout reveals stalled posts.
4. **B (look-ahead)** — verify: posts arrive already-filtered ahead of scroll; `__lnfDiag`
   shows below-fold posts pre-scored.

Each step ships as its own tagged build and is confirmed in the browser **before** the next.
No stacking unverified changes (the lesson from the 0.5.2 anchoring regression).

---

## 9. Open questions

- Default mode for new installs: keep **DIM** (smoothest) and treat gated-HIDE as opt-in?
- Should look-ahead scoring respect `maxScoresPerMin`, or only on-demand scoring?
- Do we want a "reveal animation" (fade-in) on gate release, or instant (instant = least
  motion, probably better)?

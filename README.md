## ⚠️ Terms of Service & Risk Notice

**Read this before installing.**

LN Filter modifies LinkedIn's feed entirely on the client side — it reads posts
from the page you're already viewing, scores them via the Gemini API using your
own key, and then hides, dims, or re-orders them in your browser.

This is useful. It is also **not permitted under LinkedIn's User Agreement.**
LinkedIn's [prohibited-software guidance](https://www.linkedin.com/help/linkedin/answer/a1341387)
explicitly disallows browser extensions that *scrape, modify the appearance of,
or automate activity on* the site — and LN Filter does each of those by design.
Sending post content to a third-party API (Gemini) also touches the User
Agreement's restriction on copying or distributing data obtained from the
Services through third parties.

**What this means in practice:**
- This is a contractual (ToS) matter, not a criminal one. Personal client-side
  re-ranking is a different universe from commercial scraping — but the rule
  LinkedIn wrote covers it anyway.
- The realistic risk is **account-side enforcement**: LinkedIn may restrict your
  account and ask you to disable the extension. Their detection is pattern-based.
- Local processing and using your own API key are good for *your* privacy, but
  they do **not** make the activity compliant. Neither does scroll pacing.
- Post content you view is sent to Google's Gemini API for scoring. Be mindful of
  what that means for other people's posts, not just your own.

**Use at your own risk.** By installing LN Filter you accept that you, not the
authors, are responsible for any consequences to your LinkedIn account. This
project is provided as-is, for personal and educational use, with no warranty.

> There is no fully ToS-compliant way to build feed re-ranking on LinkedIn:
> their official API does not expose the feed. That tension is inherent to the
> idea, and this notice exists so you can make an informed choice.


# LN Filter — LinkedIn Feed Re-Ranker

A Chrome extension that replaces your LinkedIn feed algorithm: rates every post with **Gemini Flash** based on your own criteria and re-sorts / filters / dims accordingly. Fully local, no backend.

## What it does

- Scans every post in the LinkedIn feed
- Rates it 0–100 according to your **interests**, **dislikes**, and **category weights**
- Hybrid strategy: visible posts first, then bulk lookahead for the next N posts
- Three modes: **Off** · **Dim** (fade out low-scoring posts) · **Hide** (remove them entirely)
- Optionally sorts the feed by score descending → genuine algorithm replacement
- Score badge on every post with a hover tooltip (category + brief reason)
- Cache (24 h default) so refreshing doesn't re-score posts you've already seen
- Floating overlay directly on LinkedIn for quick toggling

## Installation

1. Keep this folder somewhere locally.
2. Chrome → `chrome://extensions` → enable **Developer mode** (top right).
3. Click **"Load unpacked"** → select this folder.
4. Click the puzzle-piece icon in the toolbar → pin LN Filter.
5. Click the icon → **Options** → paste your **Gemini API key**.
   Free key: https://aistudio.google.com/apikey
6. Open LinkedIn (`https://www.linkedin.com/feed/`) — the overlay appears bottom-right.

## Usage

**Popup (toolbar icon):** Mode, threshold, sorting, "Re-rate", link to Options.

**Overlay on LinkedIn:** Same quick controls + live status (rated / pending).

**Options page:**
- **Model & API:** Key + Gemini variant. Default `gemini-3-flash-preview` (free tier, fast enough, good enough).
- **Interests & Dislikes:** Free text — the more specific, the better. Injected into the prompt as `{interests}` / `{dislikes}`.
- **Categories:** 16 buckets with weight 0–100. The prompt forces the model to pick exactly one.
- **Prompt:** Full rating prompt as a textarea, with a Reset button and placeholder validation. Edit at your own risk.
- **Performance & Cache:** Concurrency (default 4), thinking level (`low` recommended for bulk), retries, bulk lookahead, cache TTL, default threshold, **Google Search Grounding** (optional — see below).

### Google Search Grounding

With grounding enabled, Gemini uses live Google Search to check whether a post refers to a recent event. The default prompt contains a **recency penalty**: posts about topics / news older than 7 days are pushed to score ≤ 25 — regardless of whether the topic interests you. "Old is old."

Cost / latency: ~2–3× per call. Strict schema is dropped when grounding is on (schema + Search conflict in v1beta REST); a tolerant JSON parser is used instead. The cache key includes the grounding flag, so toggling it never mixes scored results.

Default: **off**. Turn on if you mainly use LinkedIn for news and current events.

## Architecture

```
manifest.json              MV3
background/service-worker  Gemini calls with pool + retries + score cache
content/feed.js            MutationObserver + IntersectionObserver, badge & sort
content/overlay.css        Badge + floating widget styles
popup/                     Quick controls
options/                   Full settings, glassmorphic deep design
shared/defaults.js         Default prompt, default settings, score schema
shared/gemini.js           Gemini API wrapper with extractJson + runPool
shared/storage.js          chrome.storage helper + score cache (FNV-1a hash)
icons/                     16 / 48 / 128 PNG
```

Posts are identified via a FNV-1a hash of `author|text` (stable across sessions). Sorting uses CSS `order` on a flex-column feed container — no DOM reordering, no layout thrash.

## Known Limitations

- LinkedIn renames its classes regularly. If nothing works: check `POST_SELECTORS` / `TEXT_SELECTORS` / `AUTHOR_SELECTORS` in `content/feed.js`.
- Reposts (shares) are rated based on the outer wrapper — the inner original post text is included, and the repost comment is part of it.
- Sponsored / Promoted posts are not handled separately (they go through normal scoring; they usually land in the "promo" category with a low score and get filtered).
- Images / videos are not analyzed — only text + author.
- On 429 rate-limit errors: lower concurrency; the cache handles refreshes.

## Privacy

- The API key lives exclusively in `chrome.storage.local` in your browser.
- Post text + author are sent to Gemini for the rating call — nowhere else.
- No telemetry. No server component. Full source code readable.

## Tweaking

The prompt is the most important lever. The default version optimizes for tech substance; rewrite it in Options for other profiles (the Reset button restores the default at any time).

For very restrictive filtering: threshold 60–70 + mode "Hide". For a relaxed overview: threshold 35 + mode "Dim" + sorting on.

## Debugging

In the DevTools console on `linkedin.com`:

- `__lnfDiag()` — shows what the extension currently sees: feed container found? How many children, how many with a text box, how many tracked, counters, last error.
- `__lnfDisable()` — panic switch: removes all DOM modifications and stops the scanner.

If LinkedIn changes its selectors and posts are no longer detected, `__lnfDiag()` gives you the answer within 5 seconds:

- `feed found? false` → the `[data-testid="mainFeed"]` marker no longer exists. Find a new selector in `content/feed.js` (`FEED_SELECTOR`).
- `kids w/ text box: 0` → the `[data-testid="expandable-text-box"]` marker is gone. Set a new text marker in `TEXT_SELECTOR`.
- `findReturned > 0` but `registerEmpty > 0` → `extractText` / `extractAuthor` no longer find anything — check the author selectors.

## License

Apache 2.0 — see [LICENSE](LICENSE).

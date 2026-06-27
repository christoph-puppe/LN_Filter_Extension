// Defaults used by service-worker, options page and popup (all ESM contexts).
// Content script duplicates only what it needs (it talks to storage via runtime messages).

export const DEFAULT_MODEL = "gemini-3-flash-preview";

export const MODEL_OPTIONS = [
  { id: "gemini-3.1-flash-lite-preview", label: "3.1 Flash Lite — cheap & fast" },
  { id: "gemini-3-flash-preview",        label: "3 Flash — recommended" },
  { id: "gemini-3.1-pro-preview",        label: "3.1 Pro — best quality, no Free Tier" }
];

export const DEFAULT_PROMPT = `Today is {today}.

You are rating a LinkedIn post on behalf of a user with clear preferences.

USER INTERESTS (what the user WANTS to see):
{interests}

USER DISLIKES (what the user does NOT want to see):
{dislikes}

CATEGORY WEIGHTS (0 = don't care, 100 = user really wants to see this):
{categories}

POST:
Author: {author}
Text:
{text}

TASK:
1. Determine the primary category from this list:
   tech, ai, business, career, leadership, marketing, sales, hr,
   politics, motivation, humor, personal, news, promo, recruiting, other

2. Evaluate timeliness (RECENCY CHECK):
   - Does the post refer to a specific event / news / announcement / release / conference / study?
   - IF yes, determine the event date (from the text or — if Google Search is available — via research).
   - Is the event MORE THAN 7 DAYS before {today}? → Recency penalty: score ≤ 25.
   - Within 7 days → no penalty.
   - Is the post timeless (concept, pattern, practitioner report, tutorial, personal opinion without news reference) → no recency penalty.
   - When in doubt, NO penalty (only when clearly datable AND clearly older than 7 days).

3. Assign a score 0–100 for personal relevance to this user.
   100 = should be at the top. 0 = should be hidden.

4. Provide a brief reason (max 14 words). If recency penalty applies, mention "old" or the approximate date.

IMPORTANT:
- Clear match with dislikes: score ≤ 20.
- Clear match with interests: score ≥ 70.
- Pure ads / recruiting spam without substantive content: score ≤ 30.
- Very short posts (< 20 words) without substance: score ≤ 40.
- "personal" posts (private anecdotes, babies, weddings) only high if explicitly desired.
- Recency penalty is INDEPENDENT of interest match: old is old, even if the topic fits.

OUTPUT FORMAT (JSON ONLY, no Markdown fences):
{"score": <0-100>, "category": "<one of the above>", "reason": "<max 14 words, english>"}`;

export const DEFAULT_INTERESTS = `- Concrete technical content (AI/ML, software engineering, cloud architecture)
- In-depth practitioner reports with numbers and real consequences
- Strategic analysis of the tech industry and market trends
- Tools, workflows, patterns I can use tomorrow`;

export const DEFAULT_DISLIKES = `- Motivational quotes, "X Lessons I learned from Y" without substance
- Pure ads, webinar promos, cold outreach
- Politics and election campaigns
- "Look at this incredible team / amazing journey" self-promotion
- Babies, weddings, marathon-finisher posts
- Carousel posts without content in the first slide`;

export const DEFAULT_CATEGORIES = {
  tech: 90,
  ai: 95,
  business: 60,
  career: 30,
  leadership: 40,
  marketing: 20,
  sales: 10,
  hr: 20,
  politics: 0,
  motivation: 0,
  humor: 50,
  personal: 10,
  news: 50,
  promo: 0,
  recruiting: 0,
  other: 40
};

export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: DEFAULT_MODEL,
  prompt: DEFAULT_PROMPT,
  interests: DEFAULT_INTERESTS,
  dislikes: DEFAULT_DISLIKES,
  categories: DEFAULT_CATEGORIES,
  // runtime
  mode: "dim",              // "hide" | "dim" | "off"
  threshold: 45,            // posts strictly below this are hidden/dimmed
  sortByScore: true,        // re-order feed by score desc
  concurrency: 4,           // parallel Gemini calls
  thinkingLevel: "low",     // minimal | low | medium | high
  retries: 2,
  bulkLookahead: 30,        // pre-score this many posts past the viewport (look-ahead)
  cacheTtlHours: 24,
  overlayEnabled: true,
  groundingEnabled: false,  // Google Search grounding for recency / fact checks
  // v0.6 — rank-then-show + cascade control
  gateBudget: 12,           // max posts held hidden-until-ranked at once (HIDE mode)
  gateTimeoutMs: 6000,      // force-reveal a held post not ranked within this time
  cooldownMs: 30000,        // global pause after a 429 rate-limit
  maxScoresPerMin: 0,       // optional soft cap on API calls per minute (0 = off)
  // v0.7 — experimental: gate LinkedIn's feed pagination until the current
  // batch is ranked, pacing the load cascade at the source. Default off.
  paceLoading: false
};

export const SCORE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    category: {
      type: "string",
      enum: [
        "tech", "ai", "business", "career", "leadership", "marketing",
        "sales", "hr", "politics", "motivation", "humor", "personal",
        "news", "promo", "recruiting", "other"
      ]
    },
    reason: { type: "string" }
  },
  required: ["score", "category", "reason"]
};

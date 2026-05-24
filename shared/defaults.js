// Defaults used by service-worker, options page and popup (all ESM contexts).
// Content script duplicates only what it needs (it talks to storage via runtime messages).

export const DEFAULT_MODEL = "gemini-3-flash-preview";

export const MODEL_OPTIONS = [
  { id: "gemini-3.1-flash-lite-preview", label: "3.1 Flash Lite — günstig & schnell" },
  { id: "gemini-3-flash-preview",        label: "3 Flash — empfohlen" },
  { id: "gemini-3.1-pro-preview",        label: "3.1 Pro — beste Qualität, kein Free-Tier" }
];

export const DEFAULT_PROMPT = `Du bewertest einen LinkedIn-Beitrag im Auftrag eines Users mit klaren Vorlieben.

USER-INTERESSEN (was der User SEHEN will):
{interests}

USER-DISLIKES (was der User NICHT sehen will):
{dislikes}

KATEGORIEN-GEWICHTE (0 = egal, 100 = will der User sehr gerne sehen):
{categories}

POST:
Author: {author}
Text:
{text}

AUFGABE:
1. Bestimme die primäre Kategorie aus dieser Liste:
   tech, ai, business, career, leadership, marketing, sales, hr,
   politics, motivation, humor, personal, news, promo, recruiting, other
2. Vergib einen Score 0–100 für die persönliche Relevanz für diesen User.
   100 = sollte ganz oben stehen. 0 = sollte versteckt werden.
3. Begründe knapp (max 12 Wörter).

WICHTIG:
- Bei klarem Match mit Dislikes: Score ≤ 20.
- Bei klarem Match mit Interests: Score ≥ 70.
- Reine Werbung / Recruiting-Spam ohne thematische Tiefe: Score ≤ 30.
- Bei sehr kurzen Posts (< 20 Wörter) ohne Substanz: Score ≤ 40.
- "personal"-Posts (private Anekdoten, Babys, Hochzeiten) nur hoch wenn explizit gewünscht.`;

export const DEFAULT_INTERESTS = `- Konkrete technische Inhalte (AI/ML, Software-Engineering, Cloud-Architektur)
- Tiefgehende Erfahrungsberichte von Praktikern, mit Zahlen und Konsequenzen
- Strategische Analysen zu Tech-Industrie und Markttrends
- Tools, Workflows, Pattern die ich morgen einsetzen kann`;

export const DEFAULT_DISLIKES = `- Motivations-Sprüche, "X Lessons I learned from Y" ohne Substanz
- Reine Werbung, Webinar-Promos, Cold Outreach
- Politik und Wahlkampf
- "Look at this incredible team / amazing journey" Selbstinszenierung
- Babys, Hochzeiten, Marathon-Finisher-Posts
- Karussell-Posts ohne Inhalt im ersten Slide`;

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
  bulkLookahead: 25,        // after visible items rated, pre-rate next N
  cacheTtlHours: 24,
  overlayEnabled: true
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

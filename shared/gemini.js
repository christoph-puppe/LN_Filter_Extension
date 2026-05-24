import { SCORE_SCHEMA } from "./defaults.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

const stripFences = s =>
  s.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();

// System instruction injected when grounding is on.
// systemInstruction has higher priority than user-content instructions,
// so this reliably forces JSON even when the model wants to use prose.
const GROUNDING_SYSTEM_INSTRUCTION =
  "You must respond with ONLY a valid JSON object — no markdown, no prose, no numbered list. " +
  'Exact format: {"score": <integer 0-100>, "category": "<category>", "reason": "<max 14 words>"}';

// Tolerant JSON extractor — required when grounding is on (model may wrap in
// prose), safe to always use even with strict schema.
function extractJson(text) {
  const trim = text.trim();

  // 1. Direct parse
  try { return JSON.parse(trim); } catch {}

  // 2. Strip markdown fences and parse
  const stripped = stripFences(trim);
  try { return JSON.parse(stripped); } catch {}

  // 3. Find first {...} block
  const s = stripped.indexOf("{"), e = stripped.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(stripped.slice(s, e + 1)); } catch {}
  }

  // 4. Numbered-list fallback:
  //    "1. Category: tech  2. Score: 75  3. Reason: xyz"
  //    "1. Kategorie: **tech**  2. Score: **75**  3. Begründung: ..."
  const scoreM = trim.match(/(?:score|bewert)[^\d]*(\d+)/i);
  const catM   = trim.match(/(?:category|kategorie)[^\w]*([a-z_]+)/i);
  const rsM    = trim.match(/(?:reason|begründung|begruendung)[:\s*]+(.+)/i);
  if (scoreM && catM) {
    return {
      score: Math.min(100, Math.max(0, parseInt(scoreM[1], 10))),
      category: catM[1].toLowerCase(),
      reason: rsM ? rsM[1].replace(/\*\*/g, "").trim().slice(0, 120) : ""
    };
  }

  throw new Error("could not extract JSON from response");
}

async function callGeminiOnce({ apiKey, model, prompt, thinkingLevel, grounding }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const generationConfig = {
    thinkingConfig: { thinkingLevel: thinkingLevel || "low" }
  };
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig
  };

  if (grounding) {
    // Grounding mode: tools.googleSearch enabled. Per the v1beta REST API,
    // responseJsonSchema and grounding don't combine reliably — use a
    // systemInstruction to enforce JSON + tolerant extractJson() instead.
    body.tools = [{ googleSearch: {} }];
    body.systemInstruction = {
      parts: [{ text: GROUNDING_SYSTEM_INSTRUCTION }]
    };
  } else {
    // Strict mode: schema-enforced JSON output, no search.
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = SCORE_SCHEMA;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(`Gemini ${res.status}: ${errBody.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || "")
    .join("\n");
  if (!text) throw new Error("empty response from Gemini");
  return extractJson(text);
}

export async function scorePost({ apiKey, model, prompt, thinkingLevel, retries, grounding }) {
  const maxRetries = Math.max(0, retries ?? 2);
  let attempt = 0;
  while (true) {
    try {
      return await callGeminiOnce({ apiKey, model, prompt, thinkingLevel, grounding });
    } catch (e) {
      attempt++;
      if (attempt > maxRetries) throw e;
      const wait = 500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
      await sleep(wait);
    }
  }
}

export async function runPool(tasks, limit, onProgress, cancelRef) {
  const results = new Array(tasks.length);
  let done = 0, next = 0;
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (next < tasks.length) {
        const i = next++;
        if (cancelRef?.cancelled) {
          results[i] = { cancelled: true };
          done++;
          onProgress?.(done, tasks.length);
          continue;
        }
        try {
          results[i] = { value: await tasks[i]() };
        } catch (e) {
          results[i] = { error: e.message || String(e) };
        }
        done++;
        onProgress?.(done, tasks.length);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

// Build the per-post prompt by templating settings + post into the template.
// Defensively appends any missing placeholders so the user can't break it from
// the textarea.
export function buildPrompt(template, settings, post) {
  let tpl = (template || "").trim();
  const expected = ["{interests}", "{dislikes}", "{categories}", "{author}", "{text}", "{today}"];
  for (const ph of expected) {
    if (!tpl.includes(ph)) {
      tpl += `\n\n${ph.toUpperCase().replace(/[{}]/g, "")}: ${ph}`;
    }
  }
  const categoryLines = Object.entries(settings.categories || {})
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  return tpl
    .replace("{interests}", settings.interests || "(none specified)")
    .replace("{dislikes}", settings.dislikes || "(none specified)")
    .replace("{categories}", categoryLines || "(all equal)")
    .replace("{author}", post.author || "(unknown)")
    .replace("{text}", (post.text || "").slice(0, 4000))
    .replace("{today}", today);
}

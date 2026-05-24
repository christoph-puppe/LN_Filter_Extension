import { SCORE_SCHEMA } from "./defaults.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

const stripFences = s =>
  s.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();

// Tolerant JSON extractor — required when grounding is on (model may wrap in
// prose), safe to always use even with strict schema.
function extractJson(text) {
  const trim = text.trim();
  try { return JSON.parse(trim); } catch {}
  const stripped = stripFences(trim);
  try { return JSON.parse(stripped); } catch {}
  const s = stripped.indexOf("{"), e = stripped.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(stripped.slice(s, e + 1)); } catch {}
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
    // responseJsonSchema and grounding don't combine reliably — use
    // prompt-instructed JSON + tolerant extractJson() instead.
    body.tools = [{ googleSearch: {} }];
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
    .replace("{interests}", settings.interests || "(keine angegeben)")
    .replace("{dislikes}", settings.dislikes || "(keine angegeben)")
    .replace("{categories}", categoryLines || "(alle gleich)")
    .replace("{author}", post.author || "(unbekannt)")
    .replace("{text}", (post.text || "").slice(0, 4000))
    .replace("{today}", today);
}

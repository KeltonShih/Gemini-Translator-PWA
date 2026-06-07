declare const Netlify: { env: { get(name: string): string | undefined } };

const DEFAULT_TRANSLATION_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_LOOKUP_MODEL = "gemini-3.1-flash-lite";

export interface TranslationSegment { id: string; text: string }
export interface TranslationResult { id: string; text: string }
export interface LookupResult {
  term: string;
  translation: string;
  reading?: string;
  partOfSpeech?: string;
  meaningInContext: string;
  commonUsage?: string;
  example?: string;
}

function getApiKey() {
  const key = Netlify.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("Netlify 尚未設定 GEMINI_API_KEY。");
  return key;
}

export async function translateSegments(segments: TranslationSegment[], model = DEFAULT_TRANSLATION_MODEL) {
  if (!segments.length) return [];
  const response = await callGemini({
    apiKey: getApiKey(),
    model,
    prompt: buildTranslationPrompt(segments),
    schema: translationSchema(),
    timeoutMs: 90_000
  });
  const parsed = parseJsonResponse(response) as { translations?: TranslationResult[] };
  return validateTranslations(segments, parsed.translations || []);
}

export async function lookupTerm(term: string, context: string, model = DEFAULT_LOOKUP_MODEL) {
  const response = await callGemini({
    apiKey: getApiKey(),
    model,
    prompt: buildLookupPrompt(term, context),
    schema: lookupSchema(),
    timeoutMs: 45_000
  });
  return parseJsonResponse(response) as LookupResult;
}

function buildTranslationPrompt(segments: TranslationSegment[]) {
  return [
    "You are translating a web article into Traditional Chinese for Taiwan readers.",
    "Return JSON only. Do not include markdown.",
    "",
    "Rules:",
    "- Translate naturally in Traditional Chinese, Taiwan usage, technical book style.",
    "- Do not use Simplified Chinese or Mainland China technical terms.",
    "- Preserve every placeholder exactly, for example [[KEEP_0]].",
    "- Preserve URLs, filenames, commands, API names, class names, function names, variables, and identifiers.",
    "- Keep these English terms in English unless a Chinese explanation is needed: Token, Prompt, RAG, LoRA, PEFT, API, CLI, MCP, Agent, Multi-Agent, Workflow, Context Window, Tool Calling.",
    "- For named entities and domain terms from any source language, use translated text(original source text copied verbatim from the input segment), for example 深度學習(deep learning), 東京大學(東京大学), 神經網路(ニューラルネットワーク), 인공지능(인공지능).",
    "- Apply translated text(original source text) to people, organizations, products, models, places, book or article titles, and technical terms whenever they appear.",
    "- The text inside parentheses must be copied from the input segment. Never replace a Japanese, Korean, Chinese, or other non-English source term with an English canonical term unless that exact English term appears in the input.",
    "- If the input says 深層学習, write 深度學習(深層学習), not 深度學習(deep learning). If the input says ニューラルネットワーク, write 神經網路(ニューラルネットワーク), not 神經網路(neural network).",
    "- Keep the same id for each translated segment.",
    "- Return the translations in the same order as the input.",
    "",
    "Input JSON:",
    JSON.stringify({ segments })
  ].join("\n");
}

function buildLookupPrompt(term: string, context: string) {
  return [
    "Explain the selected source-language word or phrase for a Traditional Chinese reader in Taiwan.",
    "Return JSON only. Do not include markdown.",
    "",
    "Requirements:",
    "- Focus on the meaning in this context.",
    "- Use Traditional Chinese and Taiwan wording.",
    "- If it is a technical term, explain the technical sense clearly.",
    "- Keep the selected original term visible.",
    "- If the term is Japanese, Korean, Chinese, or another non-English language, put pronunciation or reading in the reading field only when it helps understanding.",
    "",
    "Selected term:",
    term,
    "",
    "Original context:",
    context
  ].join("\n");
}

async function callGemini({ apiKey, model, prompt, schema, timeoutMs }: { apiKey: string; model: string; prompt: string; schema: unknown; timeoutMs: number }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseJsonSchema: schema }
      })
    });
    const body = await response.text();
    if (!response.ok) throw new Error(formatGeminiError(response.status, body));
    return body;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Gemini API 回應逾時，請稍後再試。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonResponse(rawBody: string) {
  const body = JSON.parse(rawBody);
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini 沒有回傳可解析的內容。");
  try { return JSON.parse(text); } catch { throw new Error("Gemini 回傳格式無法解析。"); }
}

function validateTranslations(input: TranslationSegment[], output: TranslationResult[]) {
  if (input.length !== output.length) throw new Error("Gemini 回傳的翻譯數量不一致。");
  return input.map((segment, index) => {
    const translated = output[index];
    if (!translated || translated.id !== segment.id || typeof translated.text !== "string") throw new Error("Gemini 回傳的翻譯 ID 不一致。");
    return translated;
  });
}

function translationSchema() {
  return {
    type: "object",
    properties: { translations: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] } } },
    required: ["translations"]
  };
}

function lookupSchema() {
  return {
    type: "object",
    properties: {
      term: { type: "string" }, translation: { type: "string" }, reading: { type: "string" }, partOfSpeech: { type: "string" },
      meaningInContext: { type: "string" }, commonUsage: { type: "string" }, example: { type: "string" }
    },
    required: ["term", "translation", "meaningInContext"]
  };
}

function formatGeminiError(status: number, body: string) {
  const apiMessage = extractGeminiErrorMessage(body);
  if (apiMessage) return apiMessage;
  if (status === 400) return "Gemini API 請求格式、模型名稱或 Token 長度有問題。";
  if (status === 401 || status === 403) return "Gemini API Key 無效或沒有權限。";
  if (status === 429) return "Gemini API 使用量或速率已達限制，請稍後再試。";
  if (status >= 500) return "Gemini API 目前不穩定，請稍後再試。";
  return `Gemini API 錯誤：${status}`;
}

function extractGeminiErrorMessage(body: string) {
  try {
    const message = JSON.parse(body)?.error?.message;
    return typeof message === "string" && message.trim() ? message : "";
  } catch {
    return "";
  }
}

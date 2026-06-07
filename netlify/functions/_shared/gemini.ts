declare const Netlify: { env: { get(name: string): string | undefined } };

const DEFAULT_TRANSLATION_MODEL = "gemini-3.1-flash-lite";
const QUALITY_TRANSLATION_MODEL = "gemini-3.5-flash";
const DEFAULT_LOOKUP_MODEL = "gemini-3.1-flash-lite";
const TRANSLATION_REPAIR_BATCH_SIZE = 8;
const TRANSLATION_TIMEOUT_MS = 50_000;
const ALLOWED_TRANSLATION_MODELS = new Set([DEFAULT_TRANSLATION_MODEL, QUALITY_TRANSLATION_MODEL]);

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

function normalizeTranslationModel(model: string | undefined) {
  const value = String(model || "").trim();
  return ALLOWED_TRANSLATION_MODELS.has(value) ? value : DEFAULT_TRANSLATION_MODEL;
}

export async function translateSegments(segments: TranslationSegment[], model = DEFAULT_TRANSLATION_MODEL) {
  if (!segments.length) return [];

  const apiKey = getApiKey();
  const translationModel = normalizeTranslationModel(model);
  const translatedById = new Map<string, string>();

  await translateAndCollect({ apiKey, model: translationModel, segments, translatedById, isRepair: false });

  let missing = segments.filter((segment) => !translatedById.has(segment.id));
  if (missing.length) {
    for (const batch of chunkSegments(missing, TRANSLATION_REPAIR_BATCH_SIZE)) {
      await translateAndCollect({ apiKey, model: translationModel, segments: batch, translatedById, isRepair: true }).catch(() => undefined);
    }
  }

  missing = segments.filter((segment) => !translatedById.has(segment.id));
  if (missing.length) {
    for (const segment of missing) {
      await translateAndCollect({ apiKey, model, segments: [segment], translatedById, isRepair: true }).catch(() => undefined);
    }
  }

  return segments.map((segment) => ({ id: segment.id, text: translatedById.get(segment.id) || segment.text }));
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

function buildTranslationPrompt(segments: TranslationSegment[], isRepair = false) {
  return [
    "You are a professional Traditional Chinese translator and copy editor for readers in Taiwan.",
    "Translate the provided web article segments into natural, fluent Traditional Chinese using Taiwan wording.",
    "",
    "Translation style:",
    "- Understand the source meaning first, then rewrite it in natural Chinese instead of translating word by word.",
    "- You may rearrange sentence order inside each segment when it makes the Chinese smoother.",
    "- If a source sentence is too long, split it into multiple natural Chinese sentences inside the same translated segment.",
    "- Convert passive voice into a more natural active sentence, subjectless sentence, or result-focused sentence when appropriate.",
    "- Avoid translationese and stiff phrases such as 被設計來, 以便於, 一個...的方式, 進行...的動作, 透過...來..., and 為了要.",
    "- Keep the tone suitable for a polished technical book or article.",
    "- Technical content must stay precise. Do not add, remove, exaggerate, or distort meaning.",
    "- If a source term has no natural Chinese translation, keep the original term.",
    "- Do not use Simplified Chinese or Mainland China technical terms.",
    "- Prefer Taiwan wording such as 資料, 資訊, 演算法, 軟體, 硬體, 程式, 生成式 AI, and 訊號 when appropriate.",
    "",
    "Web article and cache constraints:",
    "- Return JSON only. Do not include markdown, comments, or explanations.",
    "- Return exactly one translation item for every input segment. Do not merge, drop, or invent segments.",
    "- Keep the same id for each translated segment.",
    `- The translations array must contain exactly ${segments.length} item(s).`,
    "- Return the translations in the same order as the input.",
    "- You may split long source sentences only inside that segment's text value.",
    "- Preserve every placeholder exactly, for example [[KEEP_0]].",
    "- Preserve URLs, filenames, commands, API names, class names, function names, variables, and identifiers.",
    ...(isRepair ? ["- This is a repair request for missing segments. Translate every listed id exactly once."] : []),
    "",
    "Terminology rules:",
    "- Keep these English terms in English unless a Chinese explanation is needed: Token, Prompt, RAG, LoRA, PEFT, API, CLI, MCP, Agent, Multi-Agent, Workflow, Context Window, Tool Calling.",
    "- For named entities and domain terms from any source language, use translated text(original source text copied verbatim from the input segment), for example 深度學習(deep learning), 東京大學(東京大学), 神經網路(ニューラルネットワーク), 인공지능(인공지능).",
    "- Apply translated text(original source text) to people, organizations, products, models, places, book or article titles, and technical terms whenever they appear.",
    "- The text inside parentheses must be copied from the input segment. Never replace a Japanese, Korean, Chinese, or other non-English source term with an English canonical term unless that exact English term appears in the input.",
    "- If the input says 深層学習, write 深度學習(深層学習), not 深度學習(deep learning). If the input says ニューラルネットワーク, write 神經網路(ニューラルネットワーク), not 神經網路(neural network).",
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

async function translateAndCollect({
  apiKey,
  model,
  segments,
  translatedById,
  isRepair
}: {
  apiKey: string;
  model: string;
  segments: TranslationSegment[];
  translatedById: Map<string, string>;
  isRepair: boolean;
}) {
  const response = await callGemini({
    apiKey,
    model,
    prompt: buildTranslationPrompt(segments, isRepair),
    schema: translationSchema(),
    timeoutMs: TRANSLATION_TIMEOUT_MS
  });
  collectTranslations(segments, coerceTranslations(parseJsonResponse(response)), translatedById);
}

function collectTranslations(input: TranslationSegment[], output: TranslationResult[], translatedById: Map<string, string>) {
  const expectedIds = new Set(input.map((segment) => segment.id));

  for (const translated of output) {
    if (expectedIds.has(translated.id) && translated.text.trim()) translatedById.set(translated.id, translated.text);
  }

  if (output.length !== input.length) return;

  output.forEach((translated, index) => {
    const segment = input[index];
    if (!segment || translatedById.has(segment.id) || !translated.text.trim()) return;
    translatedById.set(segment.id, translated.text);
  });
}

function coerceTranslations(parsed: unknown) {
  const maybeObject = parsed as { translations?: unknown };
  const rawTranslations = Array.isArray(maybeObject?.translations) ? maybeObject.translations : Array.isArray(parsed) ? parsed : [];

  return rawTranslations.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { id?: unknown; text?: unknown };
    if (typeof candidate.text !== "string") return [];
    return [{ id: typeof candidate.id === "string" ? candidate.id : "", text: candidate.text }];
  });
}

function chunkSegments<T>(segments: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < segments.length; index += size) chunks.push(segments.slice(index, index + size));
  return chunks;
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

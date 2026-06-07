import type { ArticlePayload, LookupResult, TranslationResult, TranslationSegment } from "./types";

export async function fetchPage(url: string) {
  const response = await postJson<{ ok: boolean; article: ArticlePayload; error?: string }>("/api/fetch-page", { url });
  return response.article;
}

export async function translateChunk(segments: TranslationSegment[], model: string) {
  const response = await postJson<{ ok: boolean; translations: TranslationResult[]; error?: string }>("/api/translate", { segments, model });
  return response.translations;
}

export async function lookupTerm(term: string, context: string) {
  const response = await postJson<{ ok: boolean; result: LookupResult; error?: string }>("/api/lookup", { term, context });
  return response.result;
}

async function postJson<T extends { ok: boolean; error?: string }>(url: string, payload: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const rawBody = await response.text();
  const data = parseJsonResponse<T>(response, rawBody);
  if (!response.ok || !data.ok) throw new Error(data.error || `請求失敗（HTTP ${response.status}）。`);
  return data;
}

function parseJsonResponse<T>(response: Response, rawBody: string) {
  try {
    return JSON.parse(rawBody || "{}") as T;
  } catch {
    const looksLikeHtml = /^\s*</.test(rawBody);
    if (looksLikeHtml) {
      throw new Error(`翻譯服務回傳錯誤頁（HTTP ${response.status}）。高品質翻譯可能逾時，請稍後再試，或先改用快速翻譯。`);
    }
    const preview = rawBody.trim().slice(0, 120);
    throw new Error(preview ? `翻譯服務回傳格式無法解析：${preview}` : `翻譯服務沒有回傳內容（HTTP ${response.status}）。`);
  }
}

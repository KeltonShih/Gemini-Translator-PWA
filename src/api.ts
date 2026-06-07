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
  const data = (await response.json()) as T;
  if (!response.ok || !data.ok) throw new Error(data.error || "請求失敗。");
  return data;
}

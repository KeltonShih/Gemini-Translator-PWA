import type { Config, Context } from "@netlify/functions";
import { jsonResponse, methodNotAllowed, readJson, serverError } from "./_shared/http";
import { translateSegments, type TranslationSegment } from "./_shared/gemini";

interface TranslateRequest { segments?: TranslationSegment[]; model?: string }

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return methodNotAllowed();
  try {
    const payload = await readJson<TranslateRequest>(req);
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    const translations = await translateSegments(segments, payload.model);
    return jsonResponse({ ok: true, translations });
  } catch (error) {
    return serverError(error);
  }
};

export const config: Config = { path: "/api/translate" };

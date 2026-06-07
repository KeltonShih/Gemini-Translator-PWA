import type { Config, Context } from "@netlify/functions";
import { badRequest, jsonResponse, methodNotAllowed, readJson, serverError } from "./_shared/http";
import { lookupTerm } from "./_shared/gemini";

interface LookupRequest { term?: string; context?: string; model?: string }

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return methodNotAllowed();
  try {
    const payload = await readJson<LookupRequest>(req);
    const term = String(payload.term || "").trim();
    if (!term) return badRequest("請提供要查詢的原文字詞。");
    const result = await lookupTerm(term, String(payload.context || ""), payload.model);
    return jsonResponse({ ok: true, result });
  } catch (error) {
    return serverError(error);
  }
};

export const config: Config = { path: "/api/lookup" };

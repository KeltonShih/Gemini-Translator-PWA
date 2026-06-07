export function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("請提供正確的 JSON 請求內容。");
  }
}

export function methodNotAllowed() {
  return jsonResponse({ ok: false, error: "Method not allowed." }, { status: 405 });
}

export function badRequest(message: string) {
  return jsonResponse({ ok: false, error: message }, { status: 400 });
}

export function serverError(error: unknown) {
  const message = error instanceof Error ? error.message : "伺服器發生錯誤。";
  return jsonResponse({ ok: false, error: message }, { status: 500 });
}

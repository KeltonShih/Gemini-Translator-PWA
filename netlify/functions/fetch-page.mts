import type { Config, Context } from "@netlify/functions";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import sanitizeHtml from "sanitize-html";
import { badRequest, jsonResponse, methodNotAllowed, readJson, serverError } from "./_shared/http";
import { stableHash } from "./_shared/hash";

interface FetchPageRequest { url?: string }

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return methodNotAllowed();
  try {
    const payload = await readJson<FetchPageRequest>(req);
    const url = normalizeArticleUrl(payload.url || "");
    if (!url) return badRequest("請提供公開文章 URL。");

    const html = await fetchHtml(url);
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.content || (article.textContent || "").trim().length < 80) {
      return badRequest("這個頁面抓不到足夠的公開文章內容，可能需要登入或由 JavaScript 動態載入。");
    }

    const normalizedHtml = absolutizeAndSanitize(article.content, url);
    const sourceHash = stableHash([url, article.title, normalizedHtml].join("\n"));
    return jsonResponse({
      ok: true,
      article: {
        sourceUrl: url,
        title: article.title || dom.window.document.title || url,
        byline: article.byline || "",
        siteName: article.siteName || new URL(url).hostname,
        contentHtml: normalizedHtml,
        textContent: article.textContent || "",
        sourceHash,
        fetchedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    return serverError(error);
  }
};

export const config: Config = { path: "/api/fetch-page" };

function normalizeArticleUrl(input: string) {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function fetchHtml(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 GeminiTranslatorPWA/0.1 (+https://github.com/KeltonShih/Gemini-Translator-PWA)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    if (!response.ok) throw new Error(`原網頁回應錯誤：${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) throw new Error("目前只支援公開 HTML 文章頁面。");
    return response.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("抓取原網頁逾時，請稍後再試。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function absolutizeAndSanitize(contentHtml: string, pageUrl: string) {
  const dom = new JSDOM(`<main>${contentHtml}</main>`, { url: pageUrl });
  const document = dom.window.document;

  for (const link of Array.from(document.querySelectorAll("a[href]"))) {
    const href = link.getAttribute("href") || "";
    try {
      link.setAttribute("href", new URL(href, pageUrl).toString());
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } catch {
      link.removeAttribute("href");
    }
  }

  for (const image of Array.from(document.querySelectorAll("img[src]"))) {
    const src = image.getAttribute("src") || "";
    try {
      image.setAttribute("src", new URL(src, pageUrl).toString());
      image.setAttribute("loading", "lazy");
    } catch {
      image.remove();
    }
  }

  return sanitizeHtml(document.querySelector("main")?.innerHTML || "", {
    allowedTags: [
      "article", "section", "div", "p", "span", "br", "hr",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "b", "em", "i", "blockquote", "pre", "code",
      "ul", "ol", "li", "figure", "figcaption", "img", "a",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td"
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    disallowedTagsMode: "discard"
  });
}

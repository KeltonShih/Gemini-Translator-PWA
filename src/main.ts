import { fetchPage } from "./api";
import { clearAllCache } from "./cache";
import { ReaderController } from "./reader";
import type { ArticlePayload } from "./types";

const app = document.getElementById("app");
if (!app) throw new Error("App root not found.");

app.innerHTML = `
  <main class="app-shell">
    <section id="controlBand" class="control-band">
      <header class="brand-row">
        <div>
          <p class="eyebrow">Gemini Translator PWA</p>
          <h1>手機繁中閱讀</h1>
        </div>
        <div class="header-actions">
          <span id="modePill" class="mode-pill">待命</span>
          <button id="toggleControlsBtn" class="controls-toggle" type="button" aria-expanded="true">收合</button>
        </div>
      </header>
      <form id="urlForm" class="url-form">
        <label for="urlInput">文章網址</label>
        <div class="url-row">
          <input id="urlInput" type="url" inputmode="url" autocomplete="url" placeholder="https://example.com/article" />
          <button id="loadBtn" type="submit">載入</button>
        </div>
      </form>
      <div class="actions-row">
        <button id="translateBtn" type="button" disabled>翻譯</button>
        <button id="originalBtn" type="button" disabled>原文</button>
        <button id="translatedBtn" type="button" disabled>翻譯版</button>
        <button id="clearPageBtn" type="button" disabled>清本頁</button>
        <button id="clearAllBtn" type="button">清全部快取</button>
      </div>
      <section class="status-panel">
        <div>
          <p id="statusTitle">準備就緒</p>
          <p id="statusDetail">貼上公開文章網址，或從 Android Chrome 分享到這個 PWA。</p>
        </div>
        <div id="progressWrap" class="progress-wrap" hidden>
          <div class="progress-track"><div id="progressBar" class="progress-bar"></div></div>
          <span id="progressPercent">0%</span>
        </div>
      </section>
    </section>
    <section id="emptyState" class="empty-state">
      <h2>分享文章，開始翻譯</h2>
      <p>安裝 PWA 後，從 Android Chrome 分享公開文章網址到 Gemini Translator PWA。翻譯會在這裡顯示，不會改動原本 Chrome 分頁。</p>
    </section>
    <section id="articleRoot" class="reader" hidden></section>
  </main>
`;

const elements = {
  controlBand: document.getElementById("controlBand") as HTMLElement,
  modePill: document.getElementById("modePill") as HTMLElement,
  form: document.getElementById("urlForm") as HTMLFormElement,
  urlInput: document.getElementById("urlInput") as HTMLInputElement,
  translateBtn: document.getElementById("translateBtn") as HTMLButtonElement,
  originalBtn: document.getElementById("originalBtn") as HTMLButtonElement,
  translatedBtn: document.getElementById("translatedBtn") as HTMLButtonElement,
  clearPageBtn: document.getElementById("clearPageBtn") as HTMLButtonElement,
  clearAllBtn: document.getElementById("clearAllBtn") as HTMLButtonElement,
  toggleControlsBtn: document.getElementById("toggleControlsBtn") as HTMLButtonElement,
  statusTitle: document.getElementById("statusTitle") as HTMLElement,
  statusDetail: document.getElementById("statusDetail") as HTMLElement,
  progressWrap: document.getElementById("progressWrap") as HTMLElement,
  progressBar: document.getElementById("progressBar") as HTMLElement,
  progressPercent: document.getElementById("progressPercent") as HTMLElement,
  emptyState: document.getElementById("emptyState") as HTMLElement,
  articleRoot: document.getElementById("articleRoot") as HTMLElement
};

const reader = new ReaderController(elements.articleRoot, setStatus, updateMode, (url) => void loadUrl(url, true));
let currentArticle: ArticlePayload | null = null;
let controlsCollapsed = false;
let userToggledControls = false;

registerServiceWorker();

const sharedUrl = getSharedUrl();
if (sharedUrl) {
  elements.urlInput.value = sharedUrl;
  void loadUrl(sharedUrl, true);
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadUrl(elements.urlInput.value, false);
});
elements.translateBtn.addEventListener("click", () => void reader.translate());
elements.originalBtn.addEventListener("click", () => reader.showOriginal());
elements.translatedBtn.addEventListener("click", () => reader.showTranslation());
elements.clearPageBtn.addEventListener("click", () => void reader.clearCurrentCache());
elements.clearAllBtn.addEventListener("click", async () => {
  await clearAllCache();
  setStatus("已清除全部快取", "所有文章翻譯與查字快取已清除。", 0);
});
elements.toggleControlsBtn.addEventListener("click", () => {
  userToggledControls = true;
  setControlsCollapsed(!controlsCollapsed);
});

async function loadUrl(rawUrl: string, autoTranslate: boolean) {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    setStatus("網址格式不正確", "請貼上 http 或 https 開頭的公開文章網址。", 0);
    return;
  }

  setBusy(true);
  setStatus("正在載入文章", "正在抓取公開網頁並抽取主文章。", 8);
  try {
    const article = await fetchPage(url);
    currentArticle = article;
    userToggledControls = false;
    document.body.classList.add("has-article");
    elements.emptyState.hidden = true;
    elements.articleRoot.hidden = false;
    elements.urlInput.value = article.sourceUrl;
    if (typeof window.scrollTo === "function") window.scrollTo({ top: 0, behavior: "smooth" });
    await reader.loadArticle(article, autoTranslate);
    elements.clearPageBtn.disabled = false;
  } catch (error) {
    setStatus("載入失敗", error instanceof Error ? error.message : "無法載入文章。", 0);
  } finally {
    setBusy(false);
  }
}

function updateMode(mode: string) {
  const labels: Record<string, string> = { idle: "待命", original: "原文", translated: "已翻譯", translating: "翻譯中", error: "錯誤" };
  elements.modePill.textContent = labels[mode] || "待命";
  elements.modePill.dataset.mode = mode;
  elements.translateBtn.disabled = !currentArticle || mode === "translating";
  elements.originalBtn.disabled = !currentArticle || mode !== "translated";
  elements.translatedBtn.disabled = !currentArticle || mode === "translated" || mode === "translating";
  elements.clearPageBtn.disabled = !currentArticle || mode === "translating";

  if (currentArticle && isMobileReading() && !userToggledControls) {
    if (mode === "original" || mode === "translated") setControlsCollapsed(true);
    if (mode === "translating" || mode === "error") setControlsCollapsed(false);
  }
}

function setControlsCollapsed(collapsed: boolean) {
  controlsCollapsed = collapsed;
  elements.controlBand.classList.toggle("is-collapsed", collapsed);
  elements.toggleControlsBtn.textContent = collapsed ? "展開" : "收合";
  elements.toggleControlsBtn.setAttribute("aria-expanded", String(!collapsed));
}

function isMobileReading() {
  return window.matchMedia("(max-width: 920px)").matches
    || window.matchMedia("(hover: none) and (pointer: coarse)").matches
    || /Android|Mobi|iPhone|iPad/i.test(navigator.userAgent);
}

function setStatus(title: string, detail = "", progress = 0) {
  const normalized = Math.max(0, Math.min(progress, 100));
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.progressWrap.hidden = normalized <= 0 || normalized >= 100;
  elements.progressBar.style.width = `${normalized}%`;
  elements.progressPercent.textContent = `${Math.round(normalized)}%`;
}

function setBusy(busy: boolean) {
  elements.form.querySelectorAll("button, input").forEach((element) => {
    (element as HTMLButtonElement | HTMLInputElement).disabled = busy;
  });
}

function getSharedUrl() {
  const params = new URLSearchParams(location.search);
  const directUrl = params.get("url") || params.get("link") || "";
  const text = params.get("text") || "";
  return normalizeUrl(directUrl) || extractFirstUrl(text);
}

function extractFirstUrl(text: string) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? normalizeUrl(match[0]) : "";
}

function normalizeUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

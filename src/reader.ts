import { lookupTerm, translateChunk } from "./api";
import { deletePageCache, getPageCache, getTermCache, pageCacheKey, setPageCache, setTermCache, termCacheKey } from "./cache";
import type { ArticlePayload, PageCache, TranslationResult } from "./types";

const MAX_CHUNK_CHARS = 4800;
const MAX_CHUNK_ITEMS = 35;
const MIN_TEXT_LENGTH = 2;
const PROMPT_VERSION = "pwa-2026-06-07-v3";
const MODEL = "gemini-3.1-flash-lite";
const TRANSLATABLE_TEXT_PATTERN = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;
const LOOKUP_TEXT_PATTERN = /[\p{L}\p{N}]/u;
const NON_LATIN_LOOKUP_PATTERN = /[\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;
const EXCLUDED_TAGS = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SVG", "MATH", "KBD", "SAMP", "VAR", "NOSCRIPT", "SELECT", "OPTION"]);
const BLOCK_TAGS = new Set(["P", "LI", "BLOCKQUOTE", "FIGCAPTION", "TD", "TH", "DT", "DD", "H1", "H2", "H3", "H4", "H5", "H6"]);

type ReaderMode = "idle" | "original" | "translated" | "translating" | "error";

interface RecordItem {
  id: string;
  node: Node;
  originalText: string;
  coreOriginal: string;
  translatedText: string;
  translatedCore: string;
  blockId: string;
  originalHash: string;
  prefix: string;
  suffix: string;
}

interface BlockItem {
  id: string;
  element: Element;
  originalText: string;
  translatedText: string;
}

interface OverlayParts {
  host: HTMLDivElement;
  card: HTMLElement;
  selected: HTMLElement;
  original: HTMLElement;
  lookup: HTMLElement;
  lookupTerm: HTMLElement;
  lookupButton: HTMLButtonElement;
  lookupResult: HTMLElement;
  close: HTMLButtonElement;
  currentContext: string;
  currentTerm: string;
  hoverTimer: number;
}

export class ReaderController {
  private article: ArticlePayload | null = null;
  private cacheKey = "";
  private records: RecordItem[] = [];
  private blocks: BlockItem[] = [];
  private mode: ReaderMode = "idle";
  private overlay: OverlayParts | null = null;

  constructor(
    private readonly articleRoot: HTMLElement,
    private readonly status: (title: string, detail?: string, progress?: number) => void,
    private readonly modeChanged: (mode: ReaderMode) => void
  ) {
    document.addEventListener("selectionchange", () => this.handleSelection());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.dismissOverlay(true);
    });
  }

  async loadArticle(article: ArticlePayload, autoTranslate: boolean) {
    this.dismissOverlay(true);
    this.article = article;
    this.cacheKey = pageCacheKey(article.sourceUrl, article.sourceHash, MODEL, PROMPT_VERSION);
    this.renderArticle(article);
    this.setMode("original");

    const cached = await getPageCache(this.cacheKey);
    if (cached && this.applyCachedTranslations(cached)) {
      this.showTranslation();
      this.status("已載入快取翻譯", "這篇文章之前翻譯過，已直接套用。", 100);
      return;
    }

    this.status("已載入原文", "可以開始翻譯，或先閱讀原文。", 0);
    if (autoTranslate) await this.translate();
  }

  async translate() {
    if (!this.article || !this.records.length) return;
    this.setMode("translating");
    this.status("正在翻譯", "正在分段送出 Gemini 翻譯。", 4);

    try {
      const chunks = this.buildChunks();
      let completed = 0;
      for (const chunk of chunks) {
        const translations = await translateChunk(chunk.map((record) => ({ id: record.id, text: record.coreOriginal })));
        for (const translation of translations) {
          const record = this.records.find((item) => item.id === translation.id);
          if (!record) continue;
          record.translatedCore = translation.text;
          record.translatedText = record.prefix + translation.text + record.suffix;
        }
        completed += chunk.length;
        const progress = Math.max(8, Math.min(96, Math.round((completed / this.records.length) * 100)));
        this.status("正在翻譯", `已完成 ${completed} / ${this.records.length} 個文字段。`, progress);
      }

      this.rebuildBlocks();
      this.showTranslation();
      await this.saveCache();
      this.status("翻譯完成", "已保存到手機快取，下次可直接載入。", 100);
    } catch (error) {
      this.setMode("error");
      this.status("翻譯失敗", error instanceof Error ? error.message : "翻譯時發生錯誤。", 0);
    }
  }

  showOriginal() {
    this.dismissOverlay(true);
    for (const record of this.records) {
      this.replaceRecordNode(record, document.createTextNode(record.originalText));
    }
    document.documentElement.removeAttribute("data-reader-mode");
    this.setMode("original");
  }

  showTranslation() {
    this.dismissOverlay(true);
    for (const record of this.records) {
      if (record.translatedText) this.replaceRecordNode(record, this.buildTranslatedNode(record));
    }
    document.documentElement.dataset.readerMode = "translated";
    this.setMode("translated");
  }

  async clearCurrentCache() {
    if (!this.cacheKey) return;
    await deletePageCache(this.cacheKey);
    this.status("已清除本頁快取", "再次翻譯時會重新呼叫 Gemini。", 0);
  }

  private setMode(mode: ReaderMode) {
    this.mode = mode;
    this.modeChanged(mode);
  }

  private renderArticle(article: ArticlePayload) {
    this.articleRoot.innerHTML = `
      <header class="article-head">
        <p class="site-name">${escapeHtml(article.siteName)}</p>
        <h1 class="article-title">${escapeHtml(article.title)}</h1>
        <p class="byline">${escapeHtml(article.byline || new URL(article.sourceUrl).hostname)}</p>
      </header>
      <article class="article-body">${article.contentHtml}</article>
    `;
    this.collectRecords();
    this.rebuildBlocks();
  }

  private collectRecords() {
    this.records = [];
    this.blocks = [];
    const roots = Array.from(this.articleRoot.querySelectorAll(".article-title, .article-body"));
    if (!roots.length) return;

    let index = 0;
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => this.shouldTranslateTextNode(node as Text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      });

      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const originalText = node.textContent || "";
        const coreOriginal = originalText.trim();
        const block = this.findBlock(node.parentElement || root);
        const record = this.createRecord(node, originalText, coreOriginal, block.id, index);
        this.records.push(record);
        index += 1;
      }
    }
  }

  private shouldTranslateTextNode(node: Text) {
    const text = node.textContent || "";
    if (text.trim().length < MIN_TEXT_LENGTH || !TRANSLATABLE_TEXT_PATTERN.test(text)) return false;
    const element = node.parentElement;
    if (!element || element.closest("[data-reader-ui]")) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (EXCLUDED_TAGS.has(current.tagName)) return false;
    }
    return true;
  }

  private findBlock(element: Element) {
    let current: Element | null = element;
    while (current && current !== this.articleRoot) {
      if (BLOCK_TAGS.has(current.tagName)) break;
      current = current.parentElement;
    }
    const blockElement = current && current !== this.articleRoot ? current : element;
    const existing = this.blocks.find((block) => block.element === blockElement);
    if (existing) return existing;
    const block = { id: `b_${this.blocks.length}`, element: blockElement, originalText: "", translatedText: "" };
    this.blocks.push(block);
    return block;
  }

  private createRecord(node: Text, originalText: string, coreOriginal: string, blockId: string, index: number): RecordItem {
    const prefix = originalText.match(/^\s*/)?.[0] || "";
    const suffix = originalText.match(/\s*$/)?.[0] || "";
    const originalHash = stableHash(coreOriginal);
    return { id: `t_${index}_${originalHash}`, node, originalText, coreOriginal, translatedText: originalText, translatedCore: coreOriginal, blockId, originalHash, prefix, suffix };
  }

  private buildChunks() {
    const chunks: RecordItem[][] = [];
    let current: RecordItem[] = [];
    let chars = 0;
    for (const record of this.records) {
      if (current.length && (chars + record.coreOriginal.length > MAX_CHUNK_CHARS || current.length >= MAX_CHUNK_ITEMS)) {
        chunks.push(current);
        current = [];
        chars = 0;
      }
      current.push(record);
      chars += record.coreOriginal.length;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  private replaceRecordNode(record: RecordItem, nextNode: Node) {
    if (!record.node.parentNode) return;
    record.node.parentNode.replaceChild(nextNode, record.node);
    record.node = nextNode;
  }

  private buildTranslatedNode(record: RecordItem) {
    const ranges = findEmphasisRanges(record.translatedText);
    const wrapper = document.createElement("span");
    wrapper.dataset.recordId = record.id;
    if (!ranges.length) {
      wrapper.textContent = record.translatedText;
      return wrapper;
    }
    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) wrapper.appendChild(document.createTextNode(record.translatedText.slice(cursor, range.start)));
      const strong = document.createElement("strong");
      strong.dataset.term = "true";
      strong.textContent = record.translatedText.slice(range.start, range.end);
      wrapper.appendChild(strong);
      cursor = range.end;
    }
    if (cursor < record.translatedText.length) wrapper.appendChild(document.createTextNode(record.translatedText.slice(cursor)));
    return wrapper;
  }

  private rebuildBlocks() {
    for (const block of this.blocks) {
      const records = this.records.filter((record) => record.blockId === block.id);
      block.originalText = joinText(records.map((record) => record.coreOriginal));
      block.translatedText = joinText(records.map((record) => record.translatedCore || record.coreOriginal));
    }
  }

  private applyCachedTranslations(cache: PageCache) {
    if (cache.sourceHash !== this.article?.sourceHash || !cache.translations.length) return false;
    const byId = new Map(cache.translations.map((translation) => [translation.id, translation.text]));
    let applied = 0;
    for (const record of this.records) {
      const translated = byId.get(record.id);
      if (!translated) continue;
      record.translatedCore = translated;
      record.translatedText = record.prefix + translated + record.suffix;
      applied += 1;
    }
    this.rebuildBlocks();
    return applied > 0;
  }

  private async saveCache() {
    if (!this.article) return;
    const translations: TranslationResult[] = this.records.map((record) => ({ id: record.id, text: record.translatedCore }));
    await setPageCache({ key: this.cacheKey, url: this.article.sourceUrl, sourceHash: this.article.sourceHash, promptVersion: PROMPT_VERSION, model: MODEL, article: this.article, translations, savedAt: new Date().toISOString() });
  }

  private handleSelection() {
    if (this.mode !== "translated") return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const selectedText = selection.toString().trim();
    if (!selectedText || selectedText.length < 2) return;
    const range = selection.getRangeAt(0);
    const record = this.findRecordFromNode(range.commonAncestorContainer) || this.findRecordFromNode(selection.anchorNode);
    if (!record) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    this.showOriginalOverlay(record, selectedText, rect);
  }

  private findRecordFromNode(node: Node | null) {
    if (!node) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    const recordId = element?.closest?.("[data-record-id]")?.getAttribute("data-record-id");
    if (!recordId) return null;
    return this.records.find((record) => record.id === recordId) || null;
  }

  private showOriginalOverlay(record: RecordItem, selectedText: string, rect: DOMRect) {
    const block = this.blocks.find((item) => item.id === record.blockId);
    if (!block) return;
    const highlight = findAlignedOriginalRange(record, selectedText, block.originalText);
    const overlay = this.ensureOverlay();
    overlay.selected.textContent = selectedText;
    overlay.original.innerHTML = renderOriginalText(block.originalText, highlight ? [highlight] : []);
    overlay.lookup.hidden = true;
    overlay.lookupResult.innerHTML = "";
    overlay.lookupTerm.textContent = "";
    overlay.card.classList.remove("has-lookup");
    overlay.currentContext = block.originalText;
    overlay.host.style.left = `${Math.min(window.innerWidth - 24, Math.max(12, rect.left + window.scrollX))}px`;
    overlay.host.style.top = `${Math.max(12, rect.bottom + window.scrollY + 10)}px`;
    overlay.host.hidden = false;
  }

  private ensureOverlay() {
    if (this.overlay) return this.overlay;
    const host = document.createElement("div");
    host.className = "original-overlay";
    host.dataset.readerUi = "true";
    host.hidden = true;
    host.innerHTML = `
      <section class="overlay-card">
        <header class="overlay-bar"><span>原文</span><button type="button" class="overlay-close">關閉</button></header>
        <div class="overlay-content">
          <div class="source-pane"><p class="overlay-selected"></p><p class="overlay-original"></p></div>
          <section class="overlay-lookup" hidden><p class="overlay-term"></p><button class="lookup-btn" type="button">查這個字</button><div class="lookup-result"></div></section>
        </div>
      </section>`;
    document.body.appendChild(host);
    const overlay: OverlayParts = {
      host,
      card: host.querySelector(".overlay-card") as HTMLElement,
      selected: host.querySelector(".overlay-selected") as HTMLElement,
      original: host.querySelector(".overlay-original") as HTMLElement,
      lookup: host.querySelector(".overlay-lookup") as HTMLElement,
      lookupTerm: host.querySelector(".overlay-term") as HTMLElement,
      lookupButton: host.querySelector(".lookup-btn") as HTMLButtonElement,
      lookupResult: host.querySelector(".lookup-result") as HTMLElement,
      close: host.querySelector(".overlay-close") as HTMLButtonElement,
      currentContext: "",
      currentTerm: "",
      hoverTimer: 0
    };
    overlay.close.addEventListener("click", () => this.dismissOverlay(true));
    overlay.lookupButton.addEventListener("click", () => this.lookupSelectedTerm(overlay));
    overlay.original.addEventListener("mouseover", (event) => {
      const word = findWordElement(event.target);
      if (!word) return;
      window.clearTimeout(overlay.hoverTimer);
      overlay.hoverTimer = window.setTimeout(() => this.prepareTermLookup(overlay, word.dataset.term || word.textContent || "", true), 450);
    });
    overlay.original.addEventListener("mouseout", () => window.clearTimeout(overlay.hoverTimer));
    overlay.original.addEventListener("click", (event) => {
      const word = findWordElement(event.target);
      if (word) this.prepareTermLookup(overlay, word.dataset.term || word.textContent || "", true);
    });
    this.overlay = overlay;
    return overlay;
  }

  private prepareTermLookup(overlay: OverlayParts, rawTerm: string, fromHover: boolean) {
    const term = cleanLookupTerm(rawTerm);
    if (!term) return;
    overlay.currentTerm = term;
    overlay.lookupTerm.textContent = term;
    overlay.lookupResult.textContent = fromHover ? "滑鼠停留偵測到這個字，點下方按鈕查詢。" : "";
    overlay.lookupButton.hidden = false;
    overlay.lookup.hidden = false;
    overlay.card.classList.add("has-lookup");
  }

  private async lookupSelectedTerm(overlay: OverlayParts) {
    const term = overlay.currentTerm;
    if (!term) return;
    overlay.lookupButton.hidden = true;
    overlay.lookupResult.textContent = "正在查詢字詞。";
    try {
      const cacheKey = termCacheKey(term, overlay.currentContext, MODEL);
      const cached = await getTermCache(cacheKey);
      const result = cached?.result || await lookupTerm(term, overlay.currentContext);
      if (!cached) await setTermCache(cacheKey, result);
      overlay.lookupResult.innerHTML = renderLookupResult(result);
    } catch (error) {
      overlay.lookupResult.textContent = error instanceof Error ? error.message : "查詢失敗。";
      overlay.lookupButton.hidden = false;
    }
  }

  private dismissOverlay(clearSelection = false) {
    if (this.overlay) {
      window.clearTimeout(this.overlay.hoverTimer);
      this.overlay.host.hidden = true;
    }
    if (clearSelection) window.getSelection()?.removeAllRanges();
  }
}

function findAlignedOriginalRange(record: RecordItem, selectedText: string, blockText: string) {
  const originalOffset = blockText.indexOf(record.coreOriginal);
  if (originalOffset < 0) return null;
  const originalSentences = splitSentences(record.coreOriginal);
  const translatedSentences = splitSentences(record.translatedCore);
  const selectedIndex = record.translatedCore.indexOf(selectedText);
  if (selectedIndex >= 0 && originalSentences.length > 1 && translatedSentences.length > 1) {
    const sentenceIndex = translatedSentences.findIndex((sentence) => selectedIndex >= sentence.start && selectedIndex < sentence.end);
    const originalSentence = originalSentences[Math.max(0, Math.min(sentenceIndex, originalSentences.length - 1))];
    if (originalSentence) return { start: originalOffset + originalSentence.start, end: originalOffset + originalSentence.end };
  }
  return { start: originalOffset, end: originalOffset + record.coreOriginal.length };
}

function splitSentences(text: string) {
  const pattern = /[^.!?。！？]+[.!?。！？]?/g;
  const sentences: Array<{ text: string; start: number; end: number }> = [];
  let match;
  while ((match = pattern.exec(text))) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const offset = raw.search(/\S/);
    const start = match.index + (offset < 0 ? 0 : offset);
    sentences.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return sentences.length ? sentences : [{ text, start: 0, end: text.length }];
}

function renderOriginalText(text: string, ranges: Array<{ start: number; end: number }>) {
  const merged = mergeRanges(ranges.map((range) => ({ start: Math.max(0, Math.min(text.length, range.start)), end: Math.max(0, Math.min(text.length, range.end)) })).filter((range) => range.end > range.start));
  if (!merged.length) return wrapLookupTerms(text);
  let html = "";
  let cursor = 0;
  for (const range of merged) {
    html += wrapLookupTerms(text.slice(cursor, range.start));
    html += `<mark>${wrapLookupTerms(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  html += wrapLookupTerms(text.slice(cursor));
  return html;
}

function wrapLookupTerms(text: string) {
  const ranges = getLookupTermRanges(text);
  if (!ranges.length) return escapeHtml(text);
  let html = "";
  let cursor = 0;
  for (const range of ranges) {
    html += escapeHtml(text.slice(cursor, range.start));
    html += `<span class="lookup-word" data-term="${escapeAttribute(range.term)}">${escapeHtml(text.slice(range.start, range.end))}</span>`;
    cursor = range.end;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

function getLookupTermRanges(value: string) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    const ranges = [];
    for (const segment of segmenter.segment(value)) {
      if (!segment.isWordLike) continue;
      const term = cleanLookupTerm(segment.segment);
      if (isLookupTerm(term)) ranges.push({ start: segment.index, end: segment.index + segment.segment.length, term });
    }
    return ranges;
  }
  const fallbackPattern = /[A-Za-z\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F]*(?:[’'-][A-Za-z0-9\u00C0-\u024F]+)*|[\u0370-\u03FF\u0400-\u04FF][\u0370-\u03FF\u0400-\u04FF0-9-]*|[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]{1,12}/g;
  const ranges = [];
  let match;
  while ((match = fallbackPattern.exec(value))) {
    const term = cleanLookupTerm(match[0]);
    if (isLookupTerm(term)) ranges.push({ start: match.index, end: match.index + match[0].length, term });
  }
  return ranges;
}

function cleanLookupTerm(rawTerm: string) {
  const term = String(rawTerm || "").trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, "");
  if (!isLookupTerm(term)) return "";
  return term.length > 80 ? term.slice(0, 80).trim() : term;
}

function isLookupTerm(term: string) {
  const value = String(term || "").trim();
  if (!LOOKUP_TEXT_PATTERN.test(value)) return false;
  return value.length >= 2 || NON_LATIN_LOOKUP_PATTERN.test(value);
}

function findWordElement(target: EventTarget | null) {
  const element = target instanceof Element ? target : null;
  return element?.closest?.(".lookup-word") as HTMLElement | null;
}

function renderLookupResult(result: { translation?: string; reading?: string; partOfSpeech?: string; meaningInContext?: string; commonUsage?: string; example?: string }) {
  return `
    <dl>
      <dt>中文</dt><dd>${escapeHtml(result.translation || "")}</dd>
      ${result.reading ? `<dt>讀音</dt><dd>${escapeHtml(result.reading)}</dd>` : ""}
      <dt>詞性</dt><dd>${escapeHtml(result.partOfSpeech || "未標示")}</dd>
      <dt>此處意思</dt><dd>${escapeHtml(result.meaningInContext || "")}</dd>
      <dt>常見用法</dt><dd>${escapeHtml(result.commonUsage || "未提供")}</dd>
      <dt>例句</dt><dd>${escapeHtml(result.example || "未提供")}</dd>
    </dl>`;
}

function findEmphasisRanges(text: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const patterns = [
    /(?:[A-Za-z][A-Za-z0-9.+-]*\s+)?[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]{1,24}(?:\s*[A-Za-z0-9][A-Za-z0-9.+-]*)?\s*[（(][^（）()\n]{1,80}[）)]/g,
    /\b[A-Z][A-Za-z0-9.+-]*(?:\s+[A-Z][A-Za-z0-9.+-]*){0,4}\s*[（(][^（）()\n]{1,80}[）)]/g,
    /\b(?:AI|AGI|API|CLI|MCP|GPU|CPU|RAG|LoRA|PEFT|Token|Prompt|Agent|Workflow|Gemini|ChatGPT|Claude|OpenAI|DeepMind|Google|Transformer)\b/g,
    /\b[A-Z]{2,}(?:-[A-Z0-9]+)?\b/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ ...range }); else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function joinText(parts: string[]) { return parts.map((part) => part.trim()).filter(Boolean).join(" "); }

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function escapeHtml(value: string) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeAttribute(value: string) { return escapeHtml(value).replace(/`/g, "&#096;"); }

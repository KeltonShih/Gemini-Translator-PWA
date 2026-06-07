export interface ArticlePayload {
  sourceUrl: string;
  title: string;
  byline: string;
  siteName: string;
  contentHtml: string;
  textContent: string;
  sourceHash: string;
  fetchedAt: string;
}

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

export interface PageCache {
  key: string;
  url: string;
  sourceHash: string;
  promptVersion: string;
  model: string;
  article: ArticlePayload;
  translations: TranslationResult[];
  savedAt: string;
}

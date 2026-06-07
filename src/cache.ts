import type { LookupResult, PageCache } from "./types";

const DB_NAME = "gemini-translator-pwa";
const DB_VERSION = 1;
const PAGE_STORE = "pages";
const TERM_STORE = "terms";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAGE_STORE)) db.createObjectStore(PAGE_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(TERM_STORE)) db.createObjectStore(TERM_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export function pageCacheKey(url: string, sourceHash: string, model: string, promptVersion: string) {
  return ["page", normalizeUrl(url), sourceHash, model, promptVersion].join(":");
}

export function termCacheKey(term: string, context: string, model: string) {
  return ["term", stableHash(term.toLowerCase()), stableHash(context), model].join(":");
}

export async function getPageCache(key: string) { return get<PageCache>(PAGE_STORE, key); }
export async function setPageCache(cache: PageCache) { await put(PAGE_STORE, cache); }
export async function getTermCache(key: string) { return get<{ key: string; result: LookupResult; savedAt: string }>(TERM_STORE, key); }
export async function setTermCache(key: string, result: LookupResult) { await put(TERM_STORE, { key, result, savedAt: new Date().toISOString() }); }

export async function clearAllCache() {
  const db = await openDb();
  await Promise.all([clearStore(db, PAGE_STORE), clearStore(db, TERM_STORE)]);
}

export async function deletePageCache(key: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PAGE_STORE, "readwrite");
    tx.objectStore(PAGE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function get<T>(storeName: string, key: string) {
  const db = await openDb();
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve((request.result as T) || null);
    request.onerror = () => reject(request.error);
  });
}

async function put(storeName: string, value: unknown) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function clearStore(db: IDBDatabase, storeName: string) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function normalizeUrl(rawUrl: string) {
  try { const url = new URL(rawUrl); url.hash = ""; return url.toString(); } catch { return rawUrl.trim(); }
}

export function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

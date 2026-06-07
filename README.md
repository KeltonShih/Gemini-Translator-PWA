# Gemini Translator PWA

Android Chrome 無法使用桌面版 Chrome Extension，所以這個 PWA 版本讓你從 Chrome 分享公開文章網址到 PWA，並在 PWA 內閱讀繁體中文翻譯版。

## 功能

- Android Chrome 分享 URL 到 PWA 後自動載入並翻譯文章。
- 也可以在首頁貼上 URL 翻譯。
- 使用 Netlify Functions 抓公開文章 HTML，前端不保存 Gemini API Key。
- 翻譯為繁體中文（台灣用語），保留主文章、標題、圖片、表格、連結與程式碼區塊。
- 原文 / 翻譯切換不重新呼叫 Gemini。
- 選取翻譯文字可顯示對應原文浮窗。
- 原文浮窗可查原文字詞意思，支援英文、日文、韓文、中文與多種歐文。
- IndexedDB 快取同一頁翻譯結果與查字結果。

## 限制

- MVP 只支援公開文章。
- 不支援登入頁、付費頁、PDF、或需要大量 JavaScript 才渲染內容的網站。
- PWA 不會直接替換 Android Chrome 原分頁，而是在 PWA 內顯示翻譯閱讀器。
- 此版本不加登入或使用密碼；公開部署後會消耗 Netlify credits 與 Gemini API 額度。

## 本機開發

```bash
npm install
npm run dev
```

Netlify Functions 本機測試建議用：

```bash
netlify dev
```

## Netlify 設定

1. 建立 Netlify site 並連結此 GitHub repo。
2. Build command：`npm run build`
3. Publish directory：`dist`
4. Functions directory：`netlify/functions`
5. 在 Netlify Environment Variables 設定：
   - `GEMINI_API_KEY`

## Android 安裝與分享

部署完成後，在 Android Chrome 開啟網站，選擇「加到主畫面」。安裝後，Chrome 分享選單會出現 Gemini Translator PWA。

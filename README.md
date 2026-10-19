# Media Grabber（Chrome 擴充功能）

分析目前網頁中的圖片、影片、音訊（含 HLS `.m3u8` 串流），勾選後批次下載。

## 安裝

1. 到 [Releases](https://github.com/EasyBoy5566/media-grabber/releases/latest) 下載最新的 `media-grabber-vX.Y.Z.zip`
2. 解壓縮到一個**固定的位置**（例如 `文件\media-grabber`），之後更新都覆蓋這個資料夾
3. Chrome 網址列輸入 `chrome://extensions`，右上角打開「開發人員模式」
4. 點「載入未封裝項目」，選擇解壓縮出來的 `media-grabber` 資料夾
5. 把擴充功能釘選到工具列，到任一網頁點圖示即可

## 更新

擴充功能每 6 小時會檢查一次 GitHub 上的最新版本（也可以點 popup 左上角的版本號立即檢查）。
有新版本時，工具列圖示會出現 **NEW**，popup 上方會出現提示：

1. 點提示裡的「下載」取得新版 zip
2. 解壓縮，把裡面的檔案**覆蓋**到原本載入的資料夾
3. 回到 popup 按「重新載入」（或到 `chrome://extensions` 按 ↻）

> 為什麼不能全自動？Chrome 只允許從線上應用程式商店安裝的擴充功能自動更新，
> 自行載入的擴充功能無法改寫自己的檔案，所以需要手動覆蓋這一步。

## 發佈新版本（維護者）

```powershell
powershell -ExecutionPolicy Bypass -File tools\release.ps1 1.5.0
```

這個腳本會修改 `manifest.json` 的版本號、commit、打上 `v1.5.0` 標籤並推送。
GitHub Actions（`.github/workflows/release.yml`）收到標籤後會打包 zip 並建立 Release，
所有使用者的擴充功能就會在下次檢查時提示更新。

開發時直接載入本專案的 `media-grabber` 資料夾即可，修改程式碼後到 `chrome://extensions` 按 ↻ 重新載入。
圖示由 `tools/make_icons.py` 產生（需要 Pillow）。

## 檔案結構

| 檔案 | 作用 |
| --- | --- |
| `media-grabber/` | 擴充功能本體（載入這個資料夾） |
| `manifest.json` | 擴充功能設定（Manifest V3） |
| `collect.js` | `collectMedia()`：注入網頁執行，掃描媒體並回傳清單 |
| `popup.html/css/js` | 點圖示跳出的視窗：縮圖清單、分類、勾選、下載按鈕 |
| `background.js` | Service worker：執行一般下載；監聽網路請求，記下每個分頁載入的 `.m3u8`；檢查更新 |
| `icons/` | 擴充功能圖示 |
| `hls-core.js` | HLS 核心：解析播放清單、平行下載片段、AES-128 解密、合併 |
| `hls.html`、`hls-page.js` | HLS 下載分頁：選畫質／音軌、進度條、取消 |
| `batch.html`、`batch.js` | 多頁批次下載：依網址頁碼逐頁開啟、掃描、下載 |
| `shared.js` | 共用的檔名處理 |
| `page.css` | HLS 與多頁下載頁面共用的樣式 |

## 權限說明

| 權限 | 用途 |
| --- | --- |
| `scripting`、`activeTab` | 在目前網頁執行掃描程式 |
| `downloads` | 存檔 |
| `webRequest`、`storage` | 從網路請求中找出 `.m3u8`，暫存在 session 中；記住篩選設定 |
| `alarms` | 定期檢查 GitHub 上的新版本 |
| `declarativeNetRequestWithHostAccess` | 下載 HLS 片段和多頁下載的檔案時，帶上原網頁的 Referer（不少 CDN／圖床會檢查） |
| `host_permissions: <all_urls>` | 跨網域抓取影片片段、掃描跨網域 iframe |

## 運作流程

```
點擊圖示 → popup.js
  → chrome.scripting.executeScript(collectMedia)  // 在網頁裡掃描 DOM
  → 合併 background.js 從網路請求記下的 .m3u8
  → 顯示縮圖與勾選框 → 按「下載」
     ├─ 一般檔案 → background.js → chrome.downloads.download()
     └─ .m3u8   → 開新分頁 hls.html
                   → 讀主清單、選畫質 → 平行下載所有片段（6 條連線、失敗重試）
                   → AES-128 解密 → 依序合併 → 存成 .ts 或 .mp4
```

## 圖片尺寸篩選

popup 和多頁下載都可以依圖片實際像素篩選：

- 直接輸入最小寬度、最大寬度、最小高度、最大高度（0 或留空 = 不限）
- 只影響圖片，影片和音訊不受影響
- popup 的篩選設定會記住；上方會顯示「已依尺寸隱藏 N 張」

CSS 背景圖、lazy-load 圖片、`srcset` 大圖一開始不知道尺寸，工具會**在原網頁裡實際載入量測**
（沿用網頁的 Referer 和快取，防盜連的圖片也量得到）。量測期間 popup 會顯示「量測圖片尺寸中…」，
量不到尺寸的圖片（例如已失效的連結）在有設定尺寸篩選時會被隱藏。

## 多頁批次下載

適用於網址最後（或中間）有頁碼的網站，例如 `https://example.com/gallery/1`、`.../chapter-05/007`、`...?page=3`。

1. 打開第一頁 → 點擴充功能圖示 → 「多頁下載…」
2. 網址中的數字會變成可點的按鈕，點哪一個，哪一個就是頁碼（預設是最後一個數字）；
   也可以直接編輯範本，用 `{page}` 標出頁碼位置
3. 設定起始頁、結束頁、間隔；原網址是 `007` 這種有補零的，會自動帶入補零位數
4. 按「開始」：工具會開一個獨立視窗，逐頁 **載入 → 等待 → 捲動到底 → 分析 → 下載**，
   底下的表格會即時顯示每頁找到幾個、下載完成幾個

可調整的選項：

| 選項 | 說明 |
| --- | --- |
| 媒體類型 | 圖片／影片／音訊 |
| 圖片尺寸 | 最小／最大寬度、最小／最大高度（預設寬高都要 ≥ 200px） |
| 網址需包含 | 只下載網址含特定文字的檔案，例如 `/uploads/`，最能精準排除廣告和按鈕 |
| 略過已下載過的檔案 | 每頁都會出現的 logo、頭像只下載一次 |
| 自動捲動到底 | 觸發延遲載入（lazy-load）的圖片 |
| 連續幾頁失敗或空白就停止 | 遇到 404 或沒有新圖片的頁面，連續達到次數就提前結束（不知道總頁數時很好用） |
| 每頁各存一個子資料夾 | 存成 `MediaGrabber/p01/…`；關閉則存成 `MediaGrabber/p01_檔名` |

設定會記住，下次開啟時自動帶入。

注意：

- 工作視窗被其他視窗完全蓋住或縮到最小時，有些網站的延遲載入圖片可能不會出現，可以把它留在旁邊。
- 多頁下載不處理 HLS（`.m3u8`），只下載可直接下載的圖片、影片、音訊檔。
- 請把「每頁之間間隔」設得合理一點，避免對網站造成負擔或被封鎖。

## HLS 下載說明

- **找不到 m3u8？** 先打開擴充功能，再**重新整理網頁並播放影片**，讓擴充功能看到播放器發出的請求。
- 同一部影片常出現好幾個 m3u8（主清單＋各畫質清單），選檔名像 `master` / `index` / `playlist` 的那個通常就是主清單，可以在下載頁挑畫質。
- 輸出格式：
  - TS 片段 → `.ts`（VLC、PotPlayer 可直接播放）
  - fMP4 片段 → `.mp4`
- 轉成 mp4（不重新編碼）：`ffmpeg -i video.ts -c copy video.mp4`
- 如果影片的聲音是獨立音軌，會另存一個 `(audio)` 檔，下載頁會附上 ffmpeg 合併指令。
- 整部影片會先放在記憶體再存檔，非常大的影片（數 GB）可能吃光記憶體。
- 下載完成前不要關閉下載分頁。

## 會掃描的來源

- `<img>`（有 `srcset` 時只取最大張；也會讀 `data-src` 等 lazy-load 屬性）
- `<picture><source>`
- `<video>` / `<audio>` 與其 `<source>`、影片封面 `poster`
- CSS `background-image`
- `og:image`、`og:video`、`twitter:image` 等 meta
- 直接連到媒體檔的 `<a href>`
- 網路請求中的 `.m3u8`（或 Content-Type 為 mpegurl 的回應）

## 已知限制

- **DRM 保護的影片（Netflix、Disney+ 等，使用 Widevine／SAMPLE-AES）無法下載**，下載頁會顯示錯誤。
- YouTube 使用自家的 DASH 格式，不是 HLS，抓不到。
- **`.mpd`（DASH）**：暫不支援。
- `blob:` 網址無法直接下載，請改找同一頁的 HLS 項目。
- 直播串流只會下載當下已產生的片段。
- `chrome://` 頁面和 Chrome 線上應用程式商店不允許擴充功能執行腳本。

請只下載你有權保存的內容，並遵守各網站的使用條款。

## 可以再加的功能

- DASH（`.mpd`）支援
- 用 mux.js 直接把 `.ts` 轉成 `.mp4`、自動合併獨立音軌
- 大檔案改用 File System Access API 邊下載邊寫入磁碟，不佔記憶體
- 打包成 ZIP 一次下載（例如用 JSZip）
- 右鍵選單「下載此頁全部圖片」（`contextMenus` 權限）

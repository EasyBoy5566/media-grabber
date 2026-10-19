// 下載交給 service worker 處理：就算使用者關掉 popup，排隊中的下載也會繼續。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'download') return;

  (async () => {
    const results = [];
    for (const item of msg.items) {
      try {
        const id = await chrome.downloads.download({
          url: item.url,
          filename: item.filename,
          conflictAction: 'uniquify',
          saveAs: false,
        });
        results.push({ url: item.url, ok: true, id });
      } catch (err) {
        results.push({ url: item.url, ok: false, error: String(err?.message || err) });
      }
    }
    sendResponse({ results });
  })();

  return true; // 表示會非同步呼叫 sendResponse
});

// ---------- 偵測網路上的 HLS 播放清單 ----------
// 大部分串流網站的 <video> 只有 blob: 網址，真正的 .m3u8 只會出現在網路請求裡，
// 所以這裡監聽請求，把每個分頁載入過的 m3u8 記在 storage.session（瀏覽器關閉就清掉）。

const HLS_RE = /\.m3u8(\?|#|$)/i;
let queue = Promise.resolve();

function rememberHls(tabId, url) {
  queue = queue.then(async () => {
    const key = `hls:${tabId}`;
    const { [key]: list = [] } = await chrome.storage.session.get(key);
    if (list.includes(url)) return;
    list.push(url);
    await chrome.storage.session.set({ [key]: list.slice(-50) });
  }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const ct = d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
    if (HLS_RE.test(d.url) || /mpegurl/i.test(ct)) rememberHls(d.tabId, d.url);
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
  ['responseHeaders'],
);

// 分頁換頁或關閉時清掉舊紀錄
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) chrome.storage.session.remove(`hls:${tabId}`);
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`hls:${tabId}`));

// ---------- 檢查更新 ----------
// Chrome 不允許商店以外的擴充功能自動安裝更新，所以這裡只負責「發現新版本 → 提示使用者」：
// 定期讀 GitHub 最新 Release 的版本號，比目前版本新就在圖示上顯示 NEW，popup 也會出現下載提示。

const REPO = 'EasyBoy5566/media-grabber';
const UPDATE_ALARM = 'check-update';

function isNewer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  let info;
  if (res.status === 404) {
    info = { current, latest: current, hasUpdate: false, noRelease: true };
  } else if (!res.ok) {
    throw new Error(`GitHub 回應 HTTP ${res.status}`);
  } else {
    const rel = await res.json();
    const latest = rel.tag_name.replace(/^v/i, '');
    info = {
      current,
      latest,
      hasUpdate: isNewer(latest, current),
      pageUrl: rel.html_url,
      zipUrl: rel.assets?.find((a) => a.name.endsWith('.zip'))?.browser_download_url || '',
    };
  }
  info.checkedAt = Date.now();
  await chrome.storage.local.set({ updateInfo: info });
  await chrome.action.setBadgeText({ text: info.hasUpdate ? 'NEW' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#5b5bd6' });
  return info;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
  checkForUpdate().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => checkForUpdate().catch(() => {}));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === UPDATE_ALARM) checkForUpdate().catch(() => {});
});

// popup 點版本號時手動檢查
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'checkUpdate') return;
  checkForUpdate().then(sendResponse, (err) => sendResponse({ error: err.message }));
  return true;
});

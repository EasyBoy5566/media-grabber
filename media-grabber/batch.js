// 多頁批次下載：依網址範本逐頁開啟 → 等待載入 → 捲動 → 掃描媒體 → 下載。
// 由 popup 用 batch.html?url=<目前網址>&folder=... 開啟。

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const sourceUrl = params.get('url') || '';
const hasChrome = !!globalThis.chrome?.tabs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NUMBER_FIELDS = ['start', 'end', 'step', 'pad', 'minW', 'maxW', 'minH', 'maxH', 'waitAfter', 'delay', 'stopAfter'];
const TEXT_FIELDS = ['template', 'mustContain', 'folder'];
const CHECK_FIELDS = ['typeImage', 'typeVideo', 'typeAudio', 'skipCss', 'dedupe', 'scroll', 'perPageDir', 'closeWhenDone'];
const REFERER_RULE_ID = 900001;

// ---------- 設定 ----------

function readConfig() {
  const cfg = {};
  for (const f of NUMBER_FIELDS) cfg[f] = Number($('#' + f).value) || 0;
  for (const f of TEXT_FIELDS) cfg[f] = $('#' + f).value.trim();
  for (const f of CHECK_FIELDS) cfg[f] = $('#' + f).checked;
  cfg.step = Math.max(1, cfg.step);
  return cfg;
}

function writeConfig(cfg) {
  for (const f of NUMBER_FIELDS) if (f in cfg) $('#' + f).value = cfg[f];
  for (const f of TEXT_FIELDS) if (f in cfg) $('#' + f).value = cfg[f];
  for (const f of CHECK_FIELDS) if (f in cfg) $('#' + f).checked = cfg[f];
}

const pageUrl = (cfg, page) => cfg.template.replaceAll('{page}', String(page).padStart(cfg.pad, '0'));

function pageList(cfg) {
  const pages = [];
  for (let p = cfg.start; p <= cfg.end && pages.length <= 5000; p += cfg.step) pages.push(p);
  return pages;
}

function validate(cfg) {
  if (!cfg.template.includes('{page}')) return '網址範本裡需要有 {page}';
  try {
    if (!/^https?:$/.test(new URL(pageUrl(cfg, cfg.start)).protocol)) return '網址必須是 http 或 https';
  } catch {
    return '網址格式不正確';
  }
  if (cfg.end < cfg.start) return '結束頁不能小於起始頁';
  if (pageList(cfg).length > 5000) return '一次最多 5000 頁';
  if (!cfg.typeImage && !cfg.typeVideo && !cfg.typeAudio) return '至少要勾選一種媒體';
  return '';
}

function updatePreview() {
  const cfg = readConfig();
  const err = validate(cfg);
  if (err) {
    $('#preview').textContent = '⚠ ' + err;
    return;
  }
  const pages = pageList(cfg);
  const shown = pages.length <= 3
    ? pages.map((p) => pageUrl(cfg, p))
    : [pageUrl(cfg, pages[0]), pageUrl(cfg, pages[1]), '…', pageUrl(cfg, pages.at(-1))];
  $('#preview').textContent = `共 ${pages.length} 頁：` + shown.join('  ');
}

// 把原網址拆成「文字 / 數字」片段，數字可以點選設為頁碼
function renderNumberChips() {
  if (!/^https?:/i.test(sourceUrl)) return;
  const parts = sourceUrl.split(/(\d+)/);
  const numberIdx = parts.map((p, i) => (i % 2 === 1 ? i : -1)).filter((i) => i >= 0);
  if (!numberIdx.length) return;

  const pick = (idx) => {
    const num = parts[idx];
    const tpl = parts.map((p, i) => (i === idx ? '{page}' : p)).join('');
    const start = Number(num);
    $('#template').value = tpl;
    $('#start').value = start;
    $('#end').value = start + 9;
    $('#pad').value = num.length > 1 && num.startsWith('0') ? num.length : 0;
    document.querySelectorAll('#numbers button').forEach((b) => b.classList.toggle('active', Number(b.dataset.idx) === idx));
    updatePreview();
  };

  $('#numbers').replaceChildren(...parts.map((p, i) => {
    if (i % 2 === 0) {
      const s = document.createElement('span');
      s.textContent = p;
      return s;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p;
    b.dataset.idx = i;
    b.addEventListener('click', () => pick(i));
    return b;
  }));
  $('#numbersRow').hidden = false;

  // 預設：網址中最後一個數字
  if (!$('#template').value.includes('{page}')) pick(numberIdx.at(-1));
}

// ---------- 工作分頁控制 ----------

let workerTabId = null;
let workerWindowId = null;
let stopped = false;
let lastMainStatus = null; // 最近一次主頁面的 HTTP 狀態碼

function onMainFrameCompleted(d) {
  if (d.tabId === workerTabId && d.type === 'main_frame') lastMainStatus = d.statusCode;
}
function onMainFrameError(d) {
  if (d.tabId === workerTabId && d.type === 'main_frame') lastMainStatus = d.error;
}
function onWorkerRemoved(tabId) {
  if (tabId === workerTabId) {
    workerTabId = null;
    stopped = true;
  }
}

// 導向新網址並等到載入完成（先看到 loading 再看到 complete，避免收到上一頁的事件）
function loadPage(url) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    const finish = (result) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(result);
    };
    const onUpdated = (tabId, info) => {
      if (tabId !== workerTabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish('ok');
    };
    const timer = setTimeout(() => finish('timeout'), 45000);
    chrome.tabs.onUpdated.addListener(onUpdated);
    lastMainStatus = null;
    chrome.tabs.update(workerTabId, { url }).catch((e) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(e);
    });
  });
}

// 注入到網頁：一路往下捲動，觸發延遲載入
async function autoScroll() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastY = -1, still = 0;
  for (let i = 0; i < 60 && still < 3; i++) {
    window.scrollBy(0, window.innerHeight * 0.9);
    await wait(300);
    still = window.scrollY === lastY ? still + 1 : 0;
    lastY = window.scrollY;
  }
}

async function scanWorker() {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: workerTabId, allFrames: true }, func: collectMedia });
  } catch {
    results = await chrome.scripting.executeScript({ target: { tabId: workerTabId }, func: collectMedia });
  }
  const seen = new Set();
  return results.flatMap((r) => r.result || []).filter((m) => !seen.has(m.url) && seen.add(m.url));
}

function wanted(item, cfg) {
  if (/^blob:/i.test(item.url) || /\.(m3u8|mpd)(\?|#|$)/i.test(item.url)) return false;
  if (item.type === 'image' && !cfg.typeImage) return false;
  if (item.type === 'video' && !cfg.typeVideo) return false;
  if (item.type === 'audio' && !cfg.typeAudio) return false;
  if (cfg.skipCss && item.source === 'css background') return false;
  if (cfg.mustContain && !item.url.includes(cfg.mustContain)) return false;
  return true;
}

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

// ---------- 初始化 ----------

async function init() {
  if (hasChrome) {
    const { batchSettings } = await chrome.storage.local.get('batchSettings');
    if (batchSettings) writeConfig({ ...batchSettings, template: '' });
    chrome.webRequest.onCompleted.addListener(onMainFrameCompleted, { urls: ['<all_urls>'], types: ['main_frame'] });
    chrome.webRequest.onErrorOccurred.addListener(onMainFrameError, { urls: ['<all_urls>'], types: ['main_frame'] });
    chrome.tabs.onRemoved.addListener(onWorkerRemoved);
    chrome.downloads.onChanged.addListener(onDownloadChanged);
  }
  if (params.get('folder')) $('#folder').value = params.get('folder');
  renderNumberChips();
  if (!$('#template').value) $('#template').value = sourceUrl;
  updatePreview();

  $('#form').addEventListener('input', updatePreview);
  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfg = readConfig();
    const err = validate(cfg);
    if (err) return setStatus(err, 'err');
    if (!hasChrome) return setStatus('需要在擴充功能中執行', 'err');
    chrome.storage.local.set({ batchSettings: cfg });
    await run(cfg);
  });
  $('#stopBtn').addEventListener('click', () => {
    stopped = true;
    setStatus('停止中…');
  });
  window.addEventListener('beforeunload', (e) => {
    if (workerTabId != null) e.preventDefault();
  });
}

init();

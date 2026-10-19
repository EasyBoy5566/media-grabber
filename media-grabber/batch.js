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

function updateSizeChips() {
  const { minW, minH, maxW, maxH } = readConfig();
  document.querySelectorAll('#sizePresets button').forEach((b) => {
    const n = Number(b.dataset.size);
    b.classList.toggle('active', !maxW && !maxH && minW === n && minH === n);
  });
}

// 有些圖床會擋沒有 Referer 的請求（防盜連），下載時帶上目前頁面的網址
async function setDownloadReferer(referer, items) {
  const domains = [...new Set(items.filter((m) => /^https?:/i.test(m.url)).map((m) => new URL(m.url).hostname))];
  if (!domains.length) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE_ID],
    addRules: [{
      id: REFERER_RULE_ID,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
      condition: { tabIds: [chrome.tabs.TAB_ID_NONE], requestDomains: domains, resourceTypes: ['other'] },
    }],
  });
}

// ---------- 下載進度追蹤 ----------

const downloadRow = new Map(); // downloadId → row 狀態
const totals = { pages: 0, queued: 0, done: 0, failed: 0 };

function onDownloadChanged(d) {
  const row = downloadRow.get(d.id);
  if (!row || !d.state) return;
  if (d.state.current === 'complete') { row.done++; totals.done++; }
  else if (d.state.current === 'interrupted') { row.failed++; totals.failed++; }
  else return;
  downloadRow.delete(d.id);
  renderRowCount(row);
  renderSummary();
}

function renderRowCount(row) {
  if (!row.total && !row.failed) return void (row.cells.dl.textContent = '—');
  row.cells.dl.textContent = `${row.done}/${row.total}` + (row.failed ? `（${row.failed} 失敗）` : '');
  row.cells.dl.className = row.failed ? 'err' : row.done === row.total ? 'ok' : '';
}

function renderSummary() {
  $('#summary').textContent =
    `已處理 ${totals.pages} 頁 · 送出 ${totals.queued} 個下載 · 完成 ${totals.done}` +
    (totals.failed ? ` · 失敗 ${totals.failed}` : '');
}

function addRow(page, url) {
  const tr = document.createElement('tr');
  const cells = {};
  for (const k of ['page', 'url', 'found', 'dl', 'status']) {
    cells[k] = document.createElement('td');
    tr.append(cells[k]);
  }
  cells.page.textContent = page;
  cells.url.textContent = url;
  cells.url.className = 'url';
  cells.url.title = url;
  cells.status.textContent = '載入中…';
  $('#log').append(tr);
  tr.scrollIntoView({ block: 'nearest' });
  return { cells, total: 0, done: 0, failed: 0 };
}

// ---------- 主流程 ----------

async function run(cfg) {
  const pages = pageList(cfg);
  const downloaded = new Set();
  const labelWidth = String(cfg.end).length;
  let badStreak = 0;
  let stopReason = '';

  stopped = false;
  Object.assign(totals, { pages: 0, queued: 0, done: 0, failed: 0 });
  $('#log').replaceChildren();
  $('#progress').hidden = false;
  $('#startBtn').hidden = true;
  $('#stopBtn').hidden = false;
  $('#form').querySelectorAll('fieldset').forEach((f) => (f.disabled = true));
  setStatus('');
  renderSummary();

  // 開一個獨立的視窗當工作分頁，不影響使用者正在看的分頁
  const win = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1200, height: 900 });
  workerWindowId = win.id;
  workerTabId = win.tabs[0].id;

  try {
    for (let i = 0; i < pages.length && !stopped; i++) {
      const page = pages[i];
      const url = pageUrl(cfg, page);
      const row = addRow(page, url);
      $('#barFill').style.width = ((i + 1) / pages.length * 100).toFixed(1) + '%';

      const load = await loadPage(url);
      if (stopped) break;
      const httpBad = typeof lastMainStatus === 'string' || lastMainStatus >= 400;

      let items = [];
      if (!httpBad) {
        await sleep(cfg.waitAfter * 1000);
        if (cfg.scroll) {
          row.cells.status.textContent = '捲動中…';
          await chrome.scripting.executeScript({ target: { tabId: workerTabId }, func: autoScroll }).catch(() => {});
          await sleep(500);
        }
        row.cells.status.textContent = '分析中…';
        items = await scanWorker().catch(() => []);
      }
      if (stopped) break;

      // 先用類型 / 網址條件過濾、去掉重複，再量尺寸未知的圖片，最後依尺寸篩選
      const candidates = items.filter((m) => wanted(m, cfg));
      const notDup = cfg.dedupe ? candidates.filter((m) => !downloaded.has(m.url)) : candidates;
      if (sizeFilterActive(cfg) && notDup.some((m) => m.type === 'image' && !m.width)) {
        row.cells.status.textContent = '量測尺寸中…';
        await probeSizesInTab(workerTabId, notDup);
      }
      const fresh = notDup.filter((m) => passesSize(m, cfg) === true);

      const skipped = [];
      if (notDup.length > fresh.length) skipped.push(`尺寸不符 ${notDup.length - fresh.length}`);
      if (candidates.length > notDup.length) skipped.push(`略過重複 ${candidates.length - notDup.length}`);
      row.cells.found.textContent = fresh.length + (skipped.length ? `（${skipped.join('、')}）` : '');

      // 下載
      const label = String(page).padStart(labelWidth, '0');
      const dir = cfg.perPageDir ? `${cfg.folder}/p${label}` : cfg.folder;
      const prefix = cfg.perPageDir ? '' : `p${label}_`;
      row.total = fresh.length;
      if (fresh.length) await setDownloadReferer(url, fresh).catch(() => {});
      for (let j = 0; j < fresh.length; j++) {
        const m = fresh[j];
        downloaded.add(m.url);
        try {
          const id = await chrome.downloads.download({
            url: m.url,
            filename: makeFilename(m, j, dir, prefix),
            conflictAction: 'uniquify',
            saveAs: false,
          });
          downloadRow.set(id, row);
          totals.queued++;
        } catch {
          row.failed++;
          totals.failed++;
        }
      }
      renderRowCount(row);

      // 狀態欄
      if (httpBad) {
        row.cells.status.textContent = typeof lastMainStatus === 'string' ? lastMainStatus : `HTTP ${lastMainStatus}`;
        row.cells.status.className = 'err';
      } else {
        row.cells.status.textContent = load === 'timeout' ? '載入逾時（仍已分析）' : '完成';
        row.cells.status.className = fresh.length ? 'ok' : '';
      }
      totals.pages++;
      renderSummary();

      // 連續失敗 / 空白頁 → 提前結束
      badStreak = httpBad || !fresh.length ? badStreak + 1 : 0;
      if (cfg.stopAfter && badStreak >= cfg.stopAfter) {
        stopReason = `連續 ${badStreak} 頁失敗或沒有新媒體，提前停止。`;
        break;
      }

      if (i < pages.length - 1) await sleep(cfg.delay * 1000);
    }
  } catch (err) {
    stopReason = '發生錯誤：' + err.message;
  } finally {
    if (stopped && !stopReason) stopReason = workerTabId ? '已停止。' : '工作視窗被關閉，已停止。';
    if (cfg.closeWhenDone && workerWindowId != null) chrome.windows.remove(workerWindowId).catch(() => {});
    workerTabId = workerWindowId = null;
    $('#startBtn').hidden = false;
    $('#stopBtn').hidden = true;
    $('#form').querySelectorAll('fieldset').forEach((f) => (f.disabled = false));
    setStatus(
      (stopReason || '✓ 全部頁面處理完成。') + '\n檔案仍在背景下載中，可在 Chrome 的下載清單（Ctrl+J）查看進度。',
      !stopReason ? 'ok' : stopReason.startsWith('發生錯誤') ? 'err' : '',
    );
    // 下載是非同步進行的，稍後再移除 Referer 規則
    setTimeout(() => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [REFERER_RULE_ID] }), 60000);
  }
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

  updateSizeChips();
  $('#form').addEventListener('input', () => {
    updatePreview();
    updateSizeChips();
  });
  $('#sizePresets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('#minW').value = $('#minH').value = b.dataset.size;
    $('#maxW').value = $('#maxH').value = 0;
    updateSizeChips();
  });
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

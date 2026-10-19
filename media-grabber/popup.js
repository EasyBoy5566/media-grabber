const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const downloadBtn = $('#download');
const selectAllEl = $('#selectAll');
const folderEl = $('#folder');
const SIZE_FIELDS = ['minW', 'maxW', 'minH', 'maxH'];

const SVG = {
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>',
};
const TAG = { video: '影片', audio: '音訊' };

let media = [];            // 所有掃描到的項目
let filter = 'all';        // 目前的分類
let preset = '100';        // 尺寸快速選項（'custom' = 自訂）
let currentTab = null;     // 被分析的分頁
let probing = false;       // 正在量測未知尺寸的圖片
const selected = new Set(); // 勾選的 url

// ---------- 尺寸篩選 ----------

function sizeFilter() {
  const f = {};
  for (const k of SIZE_FIELDS) f[k] = Math.max(0, Number($('#' + k).value) || 0);
  return f;
}

function setPreset(value) {
  preset = value;
  if (value !== 'custom') {
    const n = Number(value) || '';
    $('#minW').value = $('#minH').value = n;
    $('#maxW').value = $('#maxH').value = '';
  }
  renderPreset();
}

function renderPreset() {
  document.querySelectorAll('#sizeChips button').forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
  $('#customSize').hidden = preset !== 'custom';
}

function saveSizeFilter() {
  chrome.storage.local.set({ popupSize: { preset, ...sizeFilter() } });
}

async function restoreSizeFilter() {
  const { popupSize } = await chrome.storage.local.get('popupSize');
  if (!popupSize) return setPreset('100');
  for (const k of SIZE_FIELDS) $('#' + k).value = popupSize[k] || '';
  preset = popupSize.preset || 'custom';
  renderPreset();
}

// ---------- 掃描 ----------

function showMessage(html) {
  listEl.innerHTML = `<div class="empty">${html}</div>`;
}

async function scan() {
  showMessage('<div class="spinner"></div>分析中…');
  $('#rescan').classList.add('spin');
  media = [];
  selected.clear();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let results;
  try {
    // 先嘗試所有 iframe；跨網域 iframe 若沒有權限會失敗，就退回只掃主頁面
    results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: collectMedia });
  } catch {
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectMedia });
    } catch (err) {
      $('#rescan').classList.remove('spin');
      showMessage(`${SVG.error}這個頁面無法分析<small>${escapeHtml(err.message)}</small>`);
      updateFooter();
      return;
    }
  }

  currentTab = tab;

  // background.js 從網路請求中記下的 m3u8
  const key = `hls:${tab.id}`;
  const { [key]: networkHls = [] } = await chrome.storage.session.get(key);
  const found = results.flatMap((r) => r.result || [])
    .concat(networkHls.map((url) => ({ url, type: 'video', source: 'network', hls: true })));

  const seen = new Set();
  for (const item of found) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    if (item.url.startsWith('blob:')) {
      item.blocked = 'blob 串流，無法直接下載';
    } else if (item.hls || /\.m3u8(\?|#|$)/i.test(item.url)) {
      item.hls = true;
      item.note = '串流 · 會開新分頁下載';
    } else if (/\.mpd(\?|#|$)/i.test(item.url)) {
      item.blocked = 'DASH 串流，暫不支援';
    }
    media.push(item);
  }
  // HLS 排最前面，比較好找
  media.sort((a, b) => (b.hls ? 1 : 0) - (a.hls ? 1 : 0));
  render();

  // CSS 背景圖、lazy-load、srcset 大圖的尺寸一開始不知道，到網頁裡實際載入量測
  if (media.some((m) => m.type === 'image' && !m.width)) {
    probing = true;
    render();
    await probeSizesInTab(tab.id, media);
    probing = false;
    render();
  }
  $('#rescan').classList.remove('spin');
}

// ---------- 畫面 ----------

function isVisible(item) {
  if (filter !== 'all' && item.type !== filter) return false;
  const ok = passesSize(item, sizeFilter());
  // 尺寸未知：量測完成前先顯示，量不到就隱藏
  return ok === null ? !item.sizeChecked : ok;
}

function render() {
  document.querySelectorAll('#filters button').forEach((b) => {
    const t = b.dataset.type;
    b.classList.toggle('active', t === filter);
    b.querySelector('.count').textContent = media.filter((m) => t === 'all' || m.type === t).length;
  });

  const visible = media.filter(isVisible);
  const hidden = media.filter((m) => m.type === 'image' && (filter === 'all' || filter === 'image') && !isVisible(m)).length;
  $('#sizeNote').textContent = probing ? '量測圖片尺寸中…' : hidden ? `已依尺寸隱藏 ${hidden} 張` : '';

  if (!visible.length) {
    showMessage(media.length
      ? `${SVG.empty}沒有符合篩選條件的媒體<small>試著放寬圖片尺寸，或切換分類</small>`
      : `${SVG.empty}這個頁面沒有找到媒體`);
  } else {
    listEl.replaceChildren(...visible.map(renderItem));
  }
  updateFooter();
}

function renderItem(item) {
  const el = document.createElement('div');
  el.className = 'card' + (item.blocked ? ' disabled' : '') + (selected.has(item.url) ? ' checked' : '');
  el.title = item.url;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const dim = document.createElement('span');
  dim.className = 'dim';

  if (item.type === 'image') {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = item.url;
    img.onload = () => {
      // 原本不知道尺寸的，縮圖載入後補上
      if (!item.width) {
        item.width = img.naturalWidth;
        item.height = img.naturalHeight;
        updateDim();
      }
    };
    img.onerror = () => img.replaceWith(htmlToNode(SVG.image));
    thumb.append(img);
  } else {
    thumb.classList.add('media');
    thumb.append(htmlToNode(SVG[item.type]));
    const tag = document.createElement('span');
    tag.className = 'tag' + (item.hls ? ' hls' : '');
    tag.textContent = item.hls ? 'HLS' : TAG[item.type];
    thumb.append(tag);
  }

  const tick = document.createElement('span');
  tick.className = 'tick';
  tick.innerHTML = SVG.check;
  thumb.append(tick, dim);

  const updateDim = () => {
    dim.textContent = item.width && item.height ? `${item.width}×${item.height}` : '';
    dim.hidden = !dim.textContent;
  };
  updateDim();

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = baseName(item);
  const sub = document.createElement('div');
  sub.className = 'sub' + (item.blocked || item.note ? ' warn' : '');
  sub.textContent = describe(item);
  meta.append(name, sub);

  el.append(thumb, meta);
  el.addEventListener('click', () => {
    if (item.blocked) return;
    const on = !selected.has(item.url);
    on ? selected.add(item.url) : selected.delete(item.url);
    el.classList.toggle('checked', on);
    updateFooter();
  });
  return el;
}

const SOURCE_LABEL = {
  'img': '圖片', 'img srcset': '圖片（最大尺寸）', 'picture': '圖片', 'css background': 'CSS 背景',
  'video poster': '影片封面', 'meta': '分享預覽圖', 'link': '連結', 'network': '網路請求',
  'video': '影片', 'audio': '音訊', 'source': '影片來源',
};

function describe(item) {
  if (item.blocked) return item.blocked;
  if (item.note) return item.note;
  if (item.type === 'image' && item.sizeChecked && !item.width) return '尺寸未知';
  return SOURCE_LABEL[item.source] || item.source || '';
}

function updateFooter() {
  const selectable = media.filter((m) => isVisible(m) && !m.blocked);
  const n = selectable.filter((m) => selected.has(m.url)).length;
  $('#downloadLabel').textContent = '下載';
  $('#downloadCount').textContent = n;
  $('#downloadCount').hidden = false;
  downloadBtn.disabled = n === 0;
  selectAllEl.checked = selectable.length > 0 && n === selectable.length;
  $('#selCount').textContent = selectable.length ? `已選 ${n} / ${selectable.length}` : '';
}

// ---------- 更新提示 ----------

async function showUpdateInfo(info) {
  const current = chrome.runtime.getManifest().version;
  $('#version').textContent = `v${current}`;
  if (!info?.hasUpdate || info.current !== current) return;
  $('#updateTitle').textContent = `有新版本 v${info.latest}`;
  $('#updateLink').href = info.zipUrl || info.pageUrl;
  $('#updateBanner').hidden = false;
}

$('#version').addEventListener('click', async () => {
  const el = $('#version');
  el.textContent = '檢查中…';
  const res = await chrome.runtime.sendMessage({ type: 'checkUpdate' });
  if (res?.error) el.textContent = `v${chrome.runtime.getManifest().version} · 無法檢查更新`;
  else if (res.hasUpdate) showUpdateInfo(res);
  else el.textContent = `v${res.current} · ${res.noRelease ? '尚無發佈版本' : '已是最新版'}`;
});

$('#reloadExt').addEventListener('click', () => chrome.runtime.reload());

// ---------- 事件 ----------

$('#filters').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  filter = btn.dataset.type;
  render();
});

$('#sizeChips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  setPreset(btn.dataset.preset);
  saveSizeFilter();
  render();
});

for (const k of SIZE_FIELDS) {
  $('#' + k).addEventListener('input', () => {
    saveSizeFilter();
    render();
  });
}

$('#rescan').addEventListener('click', scan);

$('#batch').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const q = new URLSearchParams({ url: tab.url, folder: folderEl.value.trim() });
  chrome.tabs.create({ url: `batch.html?${q}` });
});

selectAllEl.addEventListener('change', () => {
  for (const m of media) {
    if (isVisible(m) && !m.blocked) selectAllEl.checked ? selected.add(m.url) : selected.delete(m.url);
  }
  render();
});

downloadBtn.addEventListener('click', async () => {
  const chosen = media.filter((m) => isVisible(m) && !m.blocked && selected.has(m.url));
  const folder = folderEl.value.trim();
  const items = chosen.filter((m) => !m.hls).map((m, i) => ({ url: m.url, filename: makeFilename(m, i, folder) }));
  const hlsItems = chosen.filter((m) => m.hls);
  if (!chosen.length) return;

  downloadBtn.disabled = true;
  $('#downloadLabel').textContent = '下載中…';
  $('#downloadCount').hidden = true;
  let failed = 0;
  if (items.length) {
    const { results } = await chrome.runtime.sendMessage({ type: 'download', items });
    failed = results.filter((r) => !r.ok).length;
  }

  // HLS 要下載幾百個片段再合併，交給獨立分頁處理（開新分頁會讓 popup 關閉，所以放最後）
  hlsItems.forEach((m, i) => {
    const q = new URLSearchParams({
      url: m.url,
      referer: currentTab.url,
      title: currentTab.title + (hlsItems.length > 1 ? ` ${i + 1}` : ''),
      folder,
    });
    chrome.tabs.create({ url: `hls.html?${q}`, active: i === hlsItems.length - 1 });
  });

  $('#downloadLabel').textContent = failed ? `${failed} 個失敗` : `已送出 ${chosen.length} 個`;
  setTimeout(updateFooter, 2500);
});

function htmlToNode(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstChild;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

chrome.storage.local.get('updateInfo').then(({ updateInfo }) => showUpdateInfo(updateInfo));
restoreSizeFilter().then(scan);

// HLS 下載頁：由 popup 用 hls.html?url=...&referer=...&title=...&folder=... 開啟。
// 在獨立分頁裡下載，才不會因為關掉 popup 或 service worker 休眠而中斷。

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const playlistUrl = params.get('url');
const referer = params.get('referer') || '';
const folder = params.get('folder') || 'MediaGrabber';
const hasChrome = typeof chrome !== 'undefined' && !!chrome.downloads;

let master = null;        // 主清單（若有）
let controller = null;    // 用來取消下載
let downloading = false;

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

function formatBytes(n) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

function formatDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// ---------- 讓請求帶上原網頁的 Referer / Origin ----------
// 很多影片 CDN 會檢查 Referer，沒帶就回 403。

let ruleId = null;

async function applyRefererRule() {
  if (!hasChrome || !referer || !chrome.declarativeNetRequest) return;
  const tab = await chrome.tabs.getCurrent();
  ruleId = tab.id;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'referer', operation: 'set', value: referer },
          { header: 'origin', operation: 'set', value: new URL(referer).origin },
        ],
      },
      condition: { tabIds: [tab.id], resourceTypes: ['xmlhttprequest'] },
    }],
  });
}

function removeRefererRule() {
  if (ruleId != null) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

// ---------- 初始化：讀取播放清單 ----------

async function init() {
  $('#src').textContent = playlistUrl || '';
  if (!playlistUrl) return setStatus('缺少 m3u8 網址', 'err');

  $('#filename').value = sanitize(params.get('title') || '') || 'video';
  setStatus('讀取播放清單中…');

  try {
    await applyRefererRule();
    const pl = HLS.parsePlaylist(await HLS.fetchText(playlistUrl), playlistUrl);

    if (pl.kind === 'master') {
      master = pl;
      if (!pl.variants.length) throw new Error('主清單裡沒有任何畫質');
      $('#quality').replaceChildren(...pl.variants.map((v, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = [v.resolution, v.bandwidth ? (v.bandwidth / 1e6).toFixed(2) + ' Mbps' : '']
          .filter(Boolean).join(' · ') || `畫質 ${i + 1}`;
        return o;
      }));
      $('#qualityRow').hidden = false;
      $('#quality').addEventListener('change', onQualityChange);
      await onQualityChange();
    } else {
      showInfo(pl);
    }

    $('#setup').hidden = false;
    setStatus('');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

// 選某個畫質時：更新可選音軌、顯示時長與片段數
async function onQualityChange() {
  const v = master.variants[$('#quality').value];
  const tracks = master.media.filter((m) => m.type === 'AUDIO' && m.groupId === v.audio && m.url);
  $('#audioRow').hidden = !tracks.length;
  $('#audio').replaceChildren(...tracks.map((t) => {
    const o = document.createElement('option');
    o.value = t.url;
    o.textContent = [t.name, t.language].filter(Boolean).join(' · ') || '音軌';
    o.selected = t.isDefault;
    return o;
  }));

  $('#info').textContent = '讀取中…';
  try {
    showInfo(HLS.parsePlaylist(await HLS.fetchText(v.url), v.url));
  } catch (err) {
    $('#info').textContent = err.message;
  }
}

function showInfo(pl) {
  const bits = [`時長 ${formatDuration(pl.duration)}`, `${pl.segments.length} 個片段`];
  if (pl.encrypted) bits.push('AES-128 加密（會自動解密）');
  if (!pl.ended) bits.push('⚠ 直播串流，只會下載目前已產生的片段');
  $('#info').textContent = bits.join(' · ');
}

// ---------- 下載 ----------

async function downloadTrack(url, label, signal) {
  const pl = HLS.parsePlaylist(await HLS.fetchText(url, signal), url);
  if (pl.kind !== 'media') throw new Error('預期是媒體清單，卻拿到主清單');

  const t0 = performance.now();
  return HLS.downloadMedia(pl, {
    signal,
    onProgress: ({ done, total, bytes }) => {
      const sec = (performance.now() - t0) / 1000;
      $('#barFill').style.width = (done / total * 100).toFixed(1) + '%';
      $('#progressText').textContent =
        `${label}：片段 ${done} / ${total} · ${formatBytes(bytes)} · ${formatBytes(bytes / Math.max(sec, 0.1))}/s`;
    },
  });
}

async function save(blob, filename) {
  const url = URL.createObjectURL(blob);
  if (!hasChrome) {
    // 不是在擴充功能裡執行（測試用）
    Object.assign(document.createElement('a'), { href: url, download: filename.split('/').pop() }).click();
    return;
  }
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  // blob 網址要等瀏覽器寫完檔案才能釋放
  await new Promise((resolve) => {
    const onChanged = (d) => {
      if (d.id === id && d.state && d.state.current !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
  URL.revokeObjectURL(url);
}

async function start() {
  const videoUrl = master ? master.variants[$('#quality').value].url : playlistUrl;
  const audioUrl = master && !$('#audioRow').hidden ? $('#audio').value : null;
  const base = sanitize($('#filename').value) || 'video';
  const dir = sanitizeFolder(folder);
  const withDir = (name) => (dir ? `${dir}/${name}` : name);

  controller = new AbortController();
  downloading = true;
  $('#setup').hidden = true;
  $('#progress').hidden = false;
  $('#hint').hidden = true;
  setStatus('');

  try {
    await applyRefererRule(); // 重試時規則可能已被移除
    const saved = [];
    const video = await downloadTrack(videoUrl, '影片', controller.signal);
    setStatus(`合併完成（${formatBytes(video.blob.size)}），存檔中…`);
    const videoName = `${base}.${video.ext}`;
    await save(video.blob, withDir(videoName));
    saved.push(videoName);

    if (audioUrl) {
      const audio = await downloadTrack(audioUrl, '音訊', controller.signal);
      const audioName = `${base} (audio).${audio.ext}`;
      await save(audio.blob, withDir(audioName));
      saved.push(audioName);

      $('#hint').hidden = false;
      $('#hint').textContent =
        '這部影片的聲音是獨立音軌，已另存成第二個檔案。可用 ffmpeg 合併成一個 mp4：\n\n' +
        `ffmpeg -i "${videoName}" -i "${audioName}" -c copy "${base}.mp4"`;
    } else if (video.ext === 'ts') {
      $('#hint').hidden = false;
      $('#hint').textContent =
        '.ts 檔可直接用 VLC、PotPlayer 播放。若想轉成 mp4（不重新編碼，幾秒就好）：\n\n' +
        `ffmpeg -i "${videoName}" -c copy "${base}.mp4"`;
    }

    $('#barFill').style.width = '100%';
    setStatus(`✓ 下載完成：${saved.join('、')}\n可以關閉這個分頁了。`, 'ok');
  } catch (err) {
    const cancelled = controller.signal.aborted;
    controller.abort();
    setStatus(cancelled ? '已取消' : err.message, cancelled ? '' : 'err');
    $('#setup').hidden = false;
  } finally {
    downloading = false;
    $('#progress').hidden = true;
    removeRefererRule();
  }
}

$('#start').addEventListener('click', start);
$('#cancel').addEventListener('click', () => controller?.abort());
window.addEventListener('beforeunload', (e) => {
  if (downloading) e.preventDefault();
});

init();

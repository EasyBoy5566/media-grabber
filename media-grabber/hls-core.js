// HLS（.m3u8）核心邏輯：解析播放清單、下載片段、AES-128 解密、合併。
// 這個檔案不使用任何 chrome.* API，方便單獨測試。

const HLS = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 擴充功能有 host 權限、不受 CORS 限制，可以帶 Cookie（需要登入的影片）；
  // 一般網頁帶 Cookie 遇到 Access-Control-Allow-Origin: * 會被擋，所以不帶。
  const credentials = globalThis.chrome?.runtime?.id ? 'include' : 'same-origin';

  // 解析 KEY=VALUE,KEY="VALUE" 形式的屬性
  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  // "長度@起點" → { start, end }；沒有起點時接在 prevEnd 後面
  function parseByteRange(s, prevEnd = 0) {
    const [len, off] = s.split('@').map(Number);
    const start = Number.isFinite(off) ? off : prevEnd;
    return { start, end: start + len - 1 };
  }

  function parsePlaylist(text, baseUrl) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') throw new Error('這不是有效的 m3u8 播放清單');
    const resolve = (u) => new URL(u, baseUrl).href;

    // ---- 主清單（列出多種畫質）----
    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'))) {
      const variants = [];
      const media = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#EXT-X-STREAM-INF:')) {
          const a = parseAttrs(l.slice(18));
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) j++;
          if (j < lines.length) {
            variants.push({
              url: resolve(lines[j]),
              bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
              resolution: a.RESOLUTION || '',
              codecs: a.CODECS || '',
              audio: a.AUDIO || '',
            });
          }
          i = j;
        } else if (l.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttrs(l.slice(13));
          media.push({
            type: a.TYPE,
            groupId: a['GROUP-ID'],
            name: a.NAME || '',
            language: a.LANGUAGE || '',
            isDefault: a.DEFAULT === 'YES',
            url: a.URI ? resolve(a.URI) : null,
          });
        }
      }
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      return { kind: 'master', variants, media };
    }

    // ---- 媒體清單（真正的片段列表）----
    const segments = [];
    let seq = 0, duration = 0, ended = false;
    let key = null, map = null, pendingRange = null;
    const lastEnd = {};

    for (const l of lines) {
      if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seq = parseInt(l.slice(22), 10) || 0;
      } else if (l.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(l.slice(11));
        key = a.METHOD === 'NONE' ? null : {
          method: a.METHOD,
          url: a.URI ? resolve(a.URI) : null,
          iv: a.IV || null,
          keyformat: a.KEYFORMAT || 'identity',
        };
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(l.slice(11));
        map = { url: resolve(a.URI), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE) : null, key };
      } else if (l.startsWith('#EXTINF:')) {
        duration += parseFloat(l.slice(8)) || 0;
      } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = l.slice(17);
      } else if (l === '#EXT-X-ENDLIST') {
        ended = true;
      } else if (!l.startsWith('#')) {
        const url = resolve(l);
        let range = null;
        if (pendingRange) {
          range = parseByteRange(pendingRange, lastEnd[url] || 0);
          lastEnd[url] = range.end + 1;
          pendingRange = null;
        }
        segments.push({ url, range, key, map, seq: seq + segments.length });
      }
    }

    // 檢查加密方式
    for (const s of segments) {
      if (!s.key) continue;
      if (s.key.method !== 'AES-128' || s.key.keyformat !== 'identity') {
        throw new Error(`此影片使用 ${s.key.method} 加密（DRM），無法下載`);
      }
    }

    return { kind: 'media', segments, duration, ended, encrypted: segments.some((s) => s.key) };
  }

  // ---- 網路 ----

  async function fetchWithRetry(url, { range, signal, as = 'arrayBuffer' } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
        const res = await fetch(url, { headers, signal, credentials });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res[as]();
      } catch (err) {
        if (signal?.aborted || attempt >= 4) throw new Error(`下載失敗：${url}\n${err.message}`);
        await sleep(800 * attempt);
      }
    }
  }

  const fetchText = (url, signal) => fetchWithRetry(url, { signal, as: 'text' });

  // ---- 解密 ----

  function ivFor(key, seq) {
    const iv = new Uint8Array(16);
    if (key.iv) {
      const hex = key.iv.replace(/^0x/i, '').padStart(32, '0');
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
      // 沒寫 IV 時，規格規定用片段序號（big-endian）
      new DataView(iv.buffer).setUint32(12, seq);
    }
    return iv;
  }

  function makeDecryptor(signal) {
    const cache = new Map();
    const getKey = (url) => {
      if (!cache.has(url)) {
        cache.set(url, fetchWithRetry(url, { signal }).then((raw) =>
          crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt'])));
      }
      return cache.get(url);
    };
    return async (data, key, seq) => {
      if (!key) return data;
      const k = await getKey(key.url);
      return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(key, seq) }, k, data);
    };
  }

  // ---- 下載整個媒體清單 ----
  // onProgress({ done, total, bytes })；回傳 { blob, ext }
  async function downloadMedia(playlist, { signal, onProgress = () => {}, concurrency = 6 } = {}) {
    const { segments } = playlist;
    if (!segments.length) throw new Error('播放清單裡沒有任何片段');

    const decrypt = makeDecryptor(signal);
    const parts = new Array(segments.length);
    let next = 0, done = 0, bytes = 0;

    async function worker() {
      while (next < segments.length) {
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
        const i = next++;
        const s = segments[i];
        const raw = await fetchWithRetry(s.url, { range: s.range, signal });
        parts[i] = await decrypt(raw, s.key, s.seq);
        done++;
        bytes += parts[i].byteLength;
        onProgress({ done, total: segments.length, bytes });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));

    // fMP4：每遇到新的 EXT-X-MAP 就先放初始化片段
    const output = [];
    const mapData = new Map();
    let prevMap = null;
    for (let i = 0; i < segments.length; i++) {
      const m = segments[i].map;
      if (m && m !== prevMap) {
        if (!mapData.has(m)) {
          const raw = await fetchWithRetry(m.url, { range: m.range, signal });
          mapData.set(m, await decrypt(raw, m.key, 0));
        }
        output.push(mapData.get(m));
      }
      prevMap = m;
      output.push(parts[i]);
    }

    const isFmp4 = segments.some((s) => s.map);
    const segExt = (new URL(segments[0].url).pathname.match(/\.([a-z0-9]{2,4})$/i)?.[1] || '').toLowerCase();
    let ext = 'ts', type = 'video/mp2t';
    if (isFmp4) { ext = 'mp4'; type = 'video/mp4'; }
    else if (['aac', 'mp3', 'ac3'].includes(segExt)) { ext = segExt; type = `audio/${segExt === 'mp3' ? 'mpeg' : segExt}`; }

    return { blob: new Blob(output, { type }), ext };
  }

  return { parsePlaylist, fetchText, downloadMedia, parseAttrs, ivFor };
})();

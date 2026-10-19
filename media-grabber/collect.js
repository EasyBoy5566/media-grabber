// 這個函式會被注入到網頁（每個 frame）裡執行，所以必須完全自給自足：
// 不能引用外部變數，回傳值必須可以被序列化（純物件 / 陣列）。
function collectMedia() {
  const items = [];
  const seen = new Set();

  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|tiff?)(\?|#|$)/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|ogv|avi|m3u8|mpd)(\?|#|$)/i;
  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus)(\?|#|$)/i;

  const toAbs = (u) => {
    if (!u) return null;
    try { return new URL(u, document.baseURI).href; } catch { return null; }
  };

  const add = (rawUrl, type, extra = {}) => {
    const url = toAbs(rawUrl);
    if (!url || seen.has(url)) return;
    if (!/^(https?:|data:|blob:)/i.test(url)) return;
    seen.add(url);
    items.push({ url, type, source: extra.source || '', width: extra.width || 0, height: extra.height || 0 });
  };

  // srcset 取最大的那張（依 w 或 x 描述子）
  const largestFromSrcset = (srcset) => {
    if (!srcset) return null;
    let best = null, bestScore = -1;
    for (const part of srcset.split(',')) {
      const [u, d = '1x'] = part.trim().split(/\s+/);
      if (!u) continue;
      const score = parseFloat(d) || 1;
      if (score > bestScore) { best = u; bestScore = score; }
    }
    return best;
  };

  const typeFromUrl = (u) => {
    if (IMAGE_EXT.test(u)) return 'image';
    if (VIDEO_EXT.test(u)) return 'video';
    if (AUDIO_EXT.test(u)) return 'audio';
    return null;
  };

  // 1. <img>
  document.querySelectorAll('img').forEach((img) => {
    const size = { width: img.naturalWidth, height: img.naturalHeight };
    // 有 srcset 時只取最大張，避免同一張圖的多種尺寸都被列出。
    // 最大張若不是目前顯示的那張，實際尺寸未知，留給 probeImageSizes() 補上。
    const big = largestFromSrcset(img.srcset);
    if (big) add(big, 'image', toAbs(big) === img.currentSrc ? { ...size, source: 'img srcset' } : { source: 'img srcset' });
    else add(img.currentSrc || img.src, 'image', { ...size, source: 'img' });
    // 常見的 lazy-load 屬性
    for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-full']) {
      const v = img.getAttribute(attr);
      if (v) add(v, 'image', { source: attr });
    }
  });

  // 2. <picture><source srcset>
  document.querySelectorAll('picture source[srcset]').forEach((s) => {
    add(largestFromSrcset(s.srcset), 'image', { source: 'picture' });
  });

  // 3. <video> / <audio>（含 <source> 子元素）
  document.querySelectorAll('video, audio').forEach((el) => {
    const type = el.tagName === 'VIDEO' ? 'video' : 'audio';
    const size = type === 'video' ? { width: el.videoWidth, height: el.videoHeight } : {};
    add(el.currentSrc || el.src, type, { ...size, source: el.tagName.toLowerCase() });
    el.querySelectorAll('source[src]').forEach((s) => add(s.src, type, { ...size, source: 'source' }));
    if (el.poster) add(el.poster, 'image', { source: 'video poster' });
  });

  // 4. CSS background-image（限制元素數量避免大頁面卡住）
  const all = document.querySelectorAll('*');
  const limit = Math.min(all.length, 8000);
  for (let i = 0; i < limit; i++) {
    const bg = getComputedStyle(all[i]).backgroundImage;
    if (!bg || bg === 'none') continue;
    for (const m of bg.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
      add(m[2], 'image', { source: 'css background' });
    }
  }

  // 5. Open Graph / Twitter meta
  document.querySelectorAll('meta[property], meta[name]').forEach((m) => {
    const key = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
    const content = m.getAttribute('content');
    if (!content) return;
    if (/^(og:image|og:image:url|og:image:secure_url|twitter:image)$/.test(key)) add(content, 'image', { source: 'meta' });
    if (/^(og:video|og:video:url|og:video:secure_url|twitter:player:stream)$/.test(key)) add(content, 'video', { source: 'meta' });
    if (/^og:audio/.test(key)) add(content, 'audio', { source: 'meta' });
  });

  // 6. 直接連到媒體檔的 <a href>
  document.querySelectorAll('a[href]').forEach((a) => {
    const t = typeFromUrl(a.href);
    if (t) add(a.href, t, { source: 'link' });
  });

  // 7. 網頁已經載入過的 .m3u8（擴充功能安裝前就開著的頁面也抓得到）
  performance.getEntriesByType('resource').forEach((e) => {
    if (/\.m3u8(\?|#|$)/i.test(e.name)) add(e.name, 'video', { source: 'network' });
  });

  return items;
}

// 同樣注入到網頁裡執行：載入尺寸未知的圖片（CSS 背景圖、lazy-load、srcset 大圖），回傳實際寬高。
// 在網頁裡載入可以沿用網頁的 Referer 和快取，防盜連的圖床也量得到。
// 回傳 { [url]: [寬, 高] }，載入失敗的不會出現在結果裡。
async function probeImageSizes(urls, concurrency = 8, timeout = 8000) {
  const result = {};
  const queue = urls.slice(0, 500);
  const probe = (url) => new Promise((resolve) => {
    const img = new Image();
    const done = () => {
      clearTimeout(timer);
      if (img.naturalWidth) result[url] = [img.naturalWidth, img.naturalHeight];
      img.onload = img.onerror = null;
      resolve();
    };
    const timer = setTimeout(done, timeout);
    img.onload = img.onerror = done;
    img.src = url;
  });
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await probe(queue.shift());
  }));
  return result;
}

// popup、HLS 下載頁、多頁批次下載共用的檔名工具。

const DEFAULT_EXT = { image: 'jpg', video: 'mp4', audio: 'mp3' };

// 移除 Windows / Chrome 下載不允許的字元
function sanitize(s) {
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
}

// "a/b\\c" → "a/b/c"，每一層都清理過
function sanitizeFolder(folder) {
  return folder.split(/[\\/]/).map(sanitize).filter(Boolean).join('/');
}

function baseName(item) {
  if (item.name) return item.name;
  if (item.url.startsWith('data:')) return `${item.type} (data URL)`;
  try {
    const last = new URL(item.url).pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last || new URL(item.url).hostname);
  } catch {
    return item.url;
  }
}

function makeFilename(item, index, folder, prefix = '') {
  let name, ext = '';
  if (item.url.startsWith('data:')) {
    const mime = item.url.slice(5).split(/[;,]/)[0];
    ext = (mime.split('/')[1] || '').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    name = `${item.type}-${index + 1}`;
  } else {
    name = baseName(item);
  }
  name = prefix + (sanitize(name) || `${item.type}-${index + 1}`);
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.' + (ext || DEFAULT_EXT[item.type]);
  const dir = sanitizeFolder(folder);
  return dir ? `${dir}/${name}` : name;
}

// ---------- 圖片尺寸篩選 ----------
// f = { minW, minH, maxW, maxH }，0 代表不限

function sizeFilterActive(f) {
  return f.minW > 0 || f.minH > 0 || f.maxW > 0 || f.maxH > 0;
}

// true = 符合、false = 不符合、null = 尺寸未知
function passesSize(item, f) {
  if (item.type !== 'image' || !sizeFilterActive(f)) return true;
  if (!item.width || !item.height) return null;
  return item.width >= f.minW && item.height >= f.minH
    && (!f.maxW || item.width <= f.maxW) && (!f.maxH || item.height <= f.maxH);
}

// 在指定分頁裡量出尺寸未知的圖片，直接寫回 item.width / item.height；
// 量過的都會標記 sizeChecked，量不到的維持 0。
async function probeSizesInTab(tabId, items) {
  const unknown = items.filter((m) => m.type === 'image' && !m.width && !m.sizeChecked);
  if (!unknown.length) return;
  const [{ result = {} } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: probeImageSizes,
    args: [[...new Set(unknown.map((m) => m.url))]],
  }).catch(() => []);
  for (const m of unknown) {
    m.sizeChecked = true;
    if (result[m.url]) [m.width, m.height] = result[m.url];
  }
}

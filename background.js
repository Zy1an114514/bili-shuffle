/* B站随机播放 · Bili Shuffle — background (MV3) */

const API = {
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  view: (bvid) => `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  favInfo: (id) => `https://api.bilibili.com/x/v3/fav/folder/info?media_id=${id}`,
  favList: (id, pn, ps = 20) =>
    `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${id}&pn=${pn}&ps=${ps}&platform=web`,
  toview: 'https://api.bilibili.com/x/v2/history/toview',
  // 新版合集（space 页 lists/xxx 那种），和视频页里的 ugc_season 不是同一个
  seasons: (mid, sid, pn, ps = 100) =>
    `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${sid}&sort_reverse=false&page_num=${pn}&page_size=${ps}`,
};

const DEFAULT_SETTINGS = { loop: true, reshuffleOnLoop: true, autoNext: true, showBadge: true };

/* ---------- 小工具 ---------- */

// B 站接口对没有 buvid3 / Referer 的请求会直接 412。
// service worker 的 fetch 是"隐身"来源，最容易被拦；所以先用页面内 fetch，
// 实在没有 B 站标签页时再退回后台 fetch。
const BAD_CODES = new Set([-101, -400, -401, -403, -412, -352]);

async function fetchJson(url, allowCreateTab) {
  const viaTab = await fetchViaTab(url, allowCreateTab !== false);
  if (viaTab && viaTab.code === 0) return viaTab;

  let bgData = null;
  let bgErr = null;
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json', Referer: 'https://www.bilibili.com/' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    bgData = await res.json();
    if (bgData && bgData.code === 0) return bgData;
  } catch (e) {
    bgErr = e;
  }

  // 两边都失败：给出最有信息量的那条
  const bad = (bgData && BAD_CODES.has(bgData.code)) ? bgData : (viaTab && viaTab.code ? viaTab : null);
  if (bad) {
    throw new Error(`B站接口返回 ${bad.code}${bad.message ? ': ' + bad.message : ''}（先在 bilibili.com 登录、打开任意视频页再试）`);
  }
  throw bgErr || new Error('请求失败');
}

// 在某个已打开的 bilibili 标签页里执行 fetch：带的是页面自己的 cookie，最稳
async function fetchViaTab(url, allowCreate) {
  try {
    let tabs = await chrome.tabs.query({ url: '*://*.bilibili.com/*' });
    if (!tabs.length && !allowCreate) return null;
    if (!tabs.length) {
      // 一个 B 站标签页都没有时，偷偷开一个后台标签做一次请求，用完就关
      const created = await chrome.tabs.create({ url: 'https://www.bilibili.com/', active: false });
      try {
        await waitTabComplete(created.id, 15000);
        const r = await execFetch(created.id, url);
        return r;
      } finally {
        try { await chrome.tabs.remove(created.id); } catch (_) {}
      }
    }
    // 优先视频页 / 收藏夹页
    const tab = tabs.find((t) => /\/video\/|\/list\/|\/medialist\//.test(t.url || '')) || tabs[0];
    return await execFetch(tab.id, url);
  } catch (e) {
    return null;
  }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError || !t) return resolve();
        if (t.status === 'complete' || Date.now() - t0 > timeoutMs) return resolve();
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function execFetch(tabId, url) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [url],
      func: async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include', cache: 'no-store' });
          return await r.json();
        } catch (e) {
          return { code: -999, message: String(e) };
        }
      },
    });
    return results && results[0] ? results[0].result : null;
  } catch (e) {
    return null;
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanItem(o) {
  const bvid = o.bvid;
  if (!bvid) return null;
  return {
    bvid,
    title: (o.title || '').trim() || bvid,
    cover: o.cover || '',
    duration: Number(o.duration) || 0,
    upper: o.upper || '',
  };
}

async function getQueue() {
  const { bsQueue } = await chrome.storage.local.get('bsQueue');
  return bsQueue || null;
}
async function setQueue(q) {
  await chrome.storage.local.set({ bsQueue: q });
}
async function getSettings() {
  const { bsSettings } = await chrome.storage.local.get('bsSettings');
  return { ...DEFAULT_SETTINGS, ...(bsSettings || {}) };
}

/* ---------- 数据来源 ---------- */

async function fetchFavorite(mediaId) {
  // 先拿收藏夹标题
  let label = '收藏夹 ' + mediaId;
  try {
    const info = await fetchJson(API.favInfo(mediaId));
    if (info.code === 0 && info.data) label = info.data.title || label;
  } catch (_) {}

  const items = [];
  let pn = 1;
  let total = Infinity;
  while (items.length < total && pn <= 60) {
    const r = await fetchJson(API.favList(mediaId, pn));
    if (r.code !== 0) throw new Error(r.message || '收藏夹接口返回 ' + r.code);
    const d = r.data || {};
    if (d.info && typeof d.info.media_count === 'number') total = d.info.media_count;
    const medias = d.medias || [];
    if (!medias.length) break;
    for (const m of medias) {
      // type: 2 视频 / 12 音频 / 21 合集，先只要能单独播的普通视频
      if (m.type !== 2 && m.type !== undefined) continue;
      if (m.attr === 9) continue; // 已失效
      const it = cleanItem(m);
      if (it) items.push(it);
    }
    if (!d.has_more) break;
    pn++;
  }
  return { label, items, sourceUrl: 'https://www.bilibili.com/medialist/detail/ml' + mediaId };
}

// 新版合集：https://space.bilibili.com/{mid}/lists/{sid}?type=season
async function fetchSeasonList(mid, sid) {
  const items = [];
  let total = Infinity;
  let label = '合集 ' + sid;
  let pn = 1;
  while (items.length < total && pn <= 120) {
    const r = await fetchJson(API.seasons(mid, sid, pn));
    if (r.code !== 0) throw new Error(r.message || '合集接口返回 ' + r.code);
    const d = r.data || {};
    if (d.meta) {
      if (d.meta.title) label = d.meta.title;
      if (typeof d.meta.total === 'number') total = d.meta.total;
    }
    const archives = d.archives || [];
    if (!archives.length) break;
    for (const a of archives) {
      const it = cleanItem({
        bvid: a.bvid,
        title: a.title,
        cover: a.pic,
        duration: a.duration,
        upper: d.meta?.name || '',
      });
      if (it) items.push(it);
    }
    if (items.length >= total) break;
    pn++;
  }
  return { label: label + '（' + items.length + '）', items, sourceUrl: 'https://space.bilibili.com/' + mid + '/lists/' + sid + '?type=season' };
}

async function fetchToview() {
  const r = await fetchJson(API.toview);
  if (r.code !== 0) throw new Error(r.message || '稍后再看接口返回 ' + r.code);
  const list = r.data?.list || [];
  const items = list.map(cleanItem).filter(Boolean);
  return { label: '稍后再看', items, sourceUrl: 'https://www.bilibili.com/watchlater/list' };
}

async function fetchSeason(bvid) {
  const r = await fetchJson(API.view(bvid));
  if (r.code !== 0) throw new Error(r.message || '视频信息接口返回 ' + r.code);
  const d = r.data || {};
  const season = d.ugc_season;
  if (!season) return null;
  const items = [];
  for (const sec of season.sections || []) {
    for (const ep of sec.episodes || []) {
      const it = cleanItem({
        bvid: ep.bvid,
        title: ep.title || ep.arc?.title,
        cover: ep.arc?.pic,
        duration: ep.arc?.duration,
        upper: d.owner?.name,
      });
      if (it) items.push(it);
    }
  }
  if (!items.length) return null;
  return { label: season.title || '合集', items, sourceUrl: 'https://www.bilibili.com/video/' + bvid };
}

async function buildManual(text) {
  const tokens = String(text || '')
    .split(/[\s,，、\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bvids = [];
  for (const t of tokens) {
    const m = t.match(/BV[0-9A-Za-z]{10}/);
    if (m && !bvids.includes(m[0])) bvids.push(m[0]);
  }
  if (!bvids.length) throw new Error('没找到有效的 BV 号');
  const items = [];
  for (const bv of bvids.slice(0, 300)) {
    let title = bv;
    let cover = '';
    let duration = 0;
    let upper = '';
    try {
      const r = await fetchJson(API.view(bv));
      if (r.code === 0 && r.data) {
        title = r.data.title || bv;
        cover = r.data.pic || '';
        duration = r.data.duration || 0;
        upper = r.data.owner?.name || '';
      }
    } catch (_) {}
    items.push({ bvid: bv, title, cover, duration, upper });
  }
  return { label: '手动列表（' + items.length + '）', items, sourceUrl: '' };
}

/* ---------- 队列操作 ---------- */

async function makeQueue(src) {
  const settings = await getSettings();
  const items = settings.noShuffle ? src.items.slice() : shuffle(src.items);
  const q = {
    label: src.label,
    sourceUrl: src.sourceUrl || '',
    items,
    pos: 0,
    createdAt: Date.now(),
  };
  await setQueue(q);
  return q;
}

function nextIndex(q, cur, loop) {
  if (!q.items.length) return -1;
  if (loop) return (cur + 1) % q.items.length;
  const pos = cur + 1;
  return pos >= q.items.length ? -1 : pos;
}

/* ---------- 消息分发 ---------- */

async function handle(msg) {
  switch (msg.type) {
    case 'fetch': {
      // 弹窗里的轻量查询（登录态、收藏夹列表）：优先后台 fetch，
      // 失败才借用已打开的 B 站标签页，绝不新开标签。
      try {
        const res = await fetch(msg.url, {
          credentials: 'include',
          headers: { Accept: 'application/json', Referer: 'https://www.bilibili.com/' },
          cache: 'no-store',
        });
        const data = await res.json();
        if (data && data.code === 0) return data;
        const viaTab = await fetchViaTab(msg.url, false);
        return viaTab || data;
      } catch (e) {
        const viaTab = await fetchViaTab(msg.url, false);
        if (viaTab) return viaTab;
        throw e;
      }
    }
    case 'getQueue':
      return { queue: await getQueue(), settings: await getSettings() };

    case 'build:favorite': {
      const src = await fetchFavorite(msg.mediaId);
      if (!src.items.length) throw new Error('这个收藏夹里没有可播放的视频');
      const q = await makeQueue(src);
      return { queue: q, settings: await getSettings() };
    }
    case 'build:seasonlist': {
      const src = await fetchSeasonList(msg.mid, msg.sid);
      if (!src.items.length) throw new Error('这个合集里没有可播放的视频');
      const q = await makeQueue(src);
      return { queue: q, settings: await getSettings() };
    }
    case 'build:toview': {
      const src = await fetchToview();
      if (!src.items.length) throw new Error('稍后再看是空的（或者没登录）');
      const q = await makeQueue(src);
      return { queue: q, settings: await getSettings() };
    }
    case 'build:season': {
      const src = await fetchSeason(msg.bvid);
      if (!src) throw new Error('当前视频不属于某个合集');
      const q = await makeQueue(src);
      return { queue: q, settings: await getSettings() };
    }
    case 'build:manual': {
      const src = await buildManual(msg.text);
      const q = await makeQueue(src);
      return { queue: q, settings: await getSettings() };
    }

    case 'status': {
      const q = await getQueue();
      const settings = await getSettings();
      if (!q || !q.items.length) return { active: false, settings };
      const idx = q.items.findIndex((it) => it.bvid === msg.bvid);
      let pos = q.pos;
      let inQueue = idx >= 0;
      if (inQueue) {
        pos = idx;
        if (q.pos !== idx) {
          q.pos = idx;
          await setQueue(q);
        }
      }
      const ni = nextIndex(q, pos, settings.loop !== false);
      return {
        active: true,
        inQueue,
        pos,
        total: q.items.length,
        label: q.label,
        current: q.items[pos] || null,
        next: ni >= 0 ? q.items[ni] : null,
        settings,
      };
    }

    case 'advance': {
      const q = await getQueue();
      const settings = await getSettings();
      if (!q || !q.items.length) return { done: true };
      const idx = q.items.findIndex((it) => it.bvid === msg.fromBvid);
      const cur = idx >= 0 ? idx : q.pos;
      let ni = nextIndex(q, cur, settings.loop !== false);
      if (ni === -1) return { done: true };

      // 一轮播完：如果开了「重新洗牌」，跳到 0 时重排一次
      const wrapped = ni === 0 && cur === q.items.length - 1;
      if (wrapped && settings.reshuffleOnLoop && q.items.length > 1) {
        const curItem = q.items[cur];
        const rest = shuffle(q.items.filter((_, i) => i !== cur));
        q.items = [curItem, ...rest];
        ni = 1;
      }
      q.pos = ni;
      await setQueue(q);
      return { done: false, pos: ni, total: q.items.length, item: q.items[ni] };
    }

    case 'reshuffle': {
      const q = await getQueue();
      const settings = await getSettings();
      if (!q) throw new Error('还没有队列');
      const cur = q.items[q.pos];
      q.items = shuffle(q.items);
      q.pos = cur ? q.items.findIndex((it) => it.bvid === cur.bvid) : 0;
      if (q.pos < 0) q.pos = 0;
      await setQueue(q);
      return { queue: q, settings };
    }

    case 'clear': {
      await chrome.storage.local.remove('bsQueue');
      return { ok: true };
    }

    case 'setSettings': {
      const cur = await getSettings();
      const next = { ...cur, ...msg.settings };
      await chrome.storage.local.set({ bsSettings: next });
      return { settings: next };
    }

    default:
      throw new Error('未知指令: ' + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});

// 第一次安装时打开说明
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ bsSettings: DEFAULT_SETTINGS });
  }
});
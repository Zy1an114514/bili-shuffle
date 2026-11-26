/* B站随机播放 · Popup */
const $ = (id) => document.getElementById(id);
const msg = $('msg');

function say(t, ok) {
  msg.textContent = t || '';
  msg.className = 'msg' + (ok ? ' ok' : '');
}

function send(m) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(m, (r) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(r);
    });
  });
}

function fmtDur(s) {
  s = Number(s) || 0;
  if (!s) return '';
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 状态卡 ---------- */
function renderStatus(r) {
  const card = $('status');
  if (!r || !r.active) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  $('st-label').textContent = r.label || '随机队列';
  $('st-count').textContent = `${r.pos + 1} / ${r.total}`;
  const nx = r.next;
  if (r.inQueue) {
    $('st-now').innerHTML = nx
      ? `下一个：<b>${esc(nx.title)}</b> ${nx.duration ? '<span style="color:#9aa7ba">' + fmtDur(nx.duration) + '</span>' : ''}`
      : '已经是最后一个了';
  } else {
    $('st-now').innerHTML = '<span style="color:#d9882f">当前视频不在队列里</span>';
  }
}

async function loadStatus() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const bvid = tab && tab.url ? (tab.url.match(/BV[0-9A-Za-z]{10}/) || [])[0] : null;
  const r = await send({ type: 'status', bvid: bvid || '' });
  if (r && !r.error) renderStatus(r);
}

/* ---------- 设置 ---------- */
async function loadSettings() {
  const r = await send({ type: 'getQueue' });
  const s = (r && r.settings) || {};
  $('opt-loop').checked = s.loop !== false;
  $('opt-reshuffle').checked = s.reshuffleOnLoop !== false;
  $('opt-autonext').checked = s.autoNext !== false;
  $('opt-noshuffle').checked = s.noShuffle === true;
}

async function saveSettings() {
  await send({
    type: 'setSettings',
    settings: {
      loop: $('opt-loop').checked,
      reshuffleOnLoop: $('opt-reshuffle').checked,
      autoNext: $('opt-autonext').checked,
      noShuffle: $('opt-noshuffle').checked,
    },
  });
}

/* ---------- 收藏夹下拉 ---------- */
async function loadFavorites() {
  const sel = $('fav-select');
  try {
    const nav = await send({ type: 'fetch', url: 'https://api.bilibili.com/x/web-interface/nav' });
    if (!nav || nav.code !== 0 || !nav.data || !nav.data.isLogin) {
      sel.innerHTML = '<option value="">未登录 B 站，先登录一下</option>';
      return;
    }
    const mid = nav.data.mid;
    const r = await send({
      type: 'fetch',
      url: `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
    });
    const list = (r && r.data && r.data.list) || [];
    if (!list.length) {
      sel.innerHTML = '<option value="">这个账号还没有收藏夹</option>';
      return;
    }
    sel.innerHTML = list
      .map((f) => `<option value="${f.id}">${esc(f.title)} (${f.media_count})</option>`)
      .join('');
  } catch (e) {
    sel.innerHTML = '<option value="">读取失败</option>';
  }
}

/* ---------- 通用执行 ---------- */
async function run(msgObj, okText) {
  say('处理中…', true);
  const btnIds = ['btn-fav', 'btn-toview', 'btn-season', 'btn-manual'];
  btnIds.forEach((id) => { const b = $(id); if (b) b.disabled = true; });
  try {
    const r = await send(msgObj);
    if (!r) throw new Error('无响应');
    if (r.error) throw new Error(r.error);
    say(okText + `（${r.queue.items.length} 个）`, true);
    renderStatus(await statusOf(r.queue));
    // 打开第一个视频
    if (r.queue.items[0]) {
      chrome.tabs.create({ url: 'https://www.bilibili.com/video/' + r.queue.items[0].bvid });
    }
  } catch (e) {
    say('失败：' + (e.message || e));
  } finally {
    btnIds.forEach((id) => { const b = $(id); if (b) b.disabled = false; });
  }
}

async function statusOf(q) {
  return {
    active: true,
    inQueue: true,
    pos: 0,
    total: q.items.length,
    label: q.label,
    next: q.items[1] || null,
  };
}

async function currentBvid() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tabs[0] && tabs[0].url) || '';
  const m = url.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

/* ---------- 事件绑定 ---------- */
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.pane').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab);
    });
  });
});

$('btn-fav').addEventListener('click', async () => {
  const id = $('fav-select').value;
  if (!id) return say('先选一个收藏夹');
  await run({ type: 'build:favorite', mediaId: id }, '已打乱收藏夹');
});

$('btn-toview').addEventListener('click', () => run({ type: 'build:toview' }, '已打乱稍后再看'));

// space.bilibili.com/{mid}/lists/{sid}?type=season
function parseSeasonUrl(text) {
  const s = String(text || '');
  let m = s.match(/space\.bilibili\.com\/(\d+)\/lists\/(\d+)/);
  if (m) return { mid: m[1], sid: m[2] };
  m = s.match(/[?&]sid=(\d+)/);
  if (m) return { mid: null, sid: m[1] };
  m = s.match(/^(\d{5,})$/) ;
  if (m) return { mid: null, sid: m[1] };
  return null;
}

$('btn-season-url').addEventListener('click', async () => {
  const raw = $('season-url').value.trim();
  if (!raw) return say('先粘贴合集链接');
  const ids = parseSeasonUrl(raw);
  if (!ids) return say('链接认不出来，格式要是 space.bilibili.com/…/lists/数字');
  // mid 没给时，去视频页/space 页找一下当前 up
  let mid = ids.mid;
  if (!mid) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = (tabs[0] && tabs[0].url) || '';
    const mm = u.match(/space\.bilibili\.com\/(\d+)/);
    mid = mm ? mm[1] : '';
  }
  if (!mid) return say('这个链接里没有 UP 主 ID，贴完整链接');
  await run({ type: 'build:seasonlist', mid, sid: ids.sid }, '已打乱合集');
});

$('btn-season').addEventListener('click', async () => {
  const bv = await currentBvid();
  if (!bv) return say('请先打开一个 B 站视频页');
  await run({ type: 'build:season', bvid: bv }, '已打乱合集');
});

$('btn-manual').addEventListener('click', () => {
  const text = $('manual-input').value.trim();
  if (!text) return say('先粘贴 BV 号');
  run({ type: 'build:manual', text }, '已打乱手动列表');
});

$('btn-reshuffle').addEventListener('click', async () => {
  const r = await send({ type: 'reshuffle' });
  if (r && r.error) return say(r.error);
  await loadStatus();
  say('已重新洗牌', true);
});

$('btn-next').addEventListener('click', async () => {
  const bv = await currentBvid();
  const r = await send({ type: 'advance', fromBvid: bv });
  if (!r || r.error) return say((r && r.error) || '失败');
  if (r.done) return say('队列已经播完了');
  chrome.tabs.update({ url: 'https://www.bilibili.com/video/' + r.item.bvid });
  window.close();
});

$('btn-clear').addEventListener('click', async () => {
  await send({ type: 'clear' });
  $('status').classList.add('hidden');
  say('已停用随机队列', true);
});

['opt-loop', 'opt-reshuffle', 'opt-autonext', 'opt-noshuffle'].forEach((id) => {
  $(id).addEventListener('change', saveSettings);
});

/* ---------- 初始化 ---------- */
(async () => {
  await loadSettings();
  await loadStatus();
  // 当前页正好是合集页时，自动填进输入框并切到那个标签
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = (tabs[0] && tabs[0].url) || '';
    if (/space\.bilibili\.com\/\d+\/lists\/\d+/.test(u)) {
      $('season-url').value = u;
      document.querySelector('.tab[data-tab="season"]').click();
    }
  } catch (e) {}
  await loadFavorites();
})();
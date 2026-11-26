/* B站随机播放 · Bili Shuffle — content script */
(() => {
  if (window.__biliShuffleInjected) return;
  window.__biliShuffleInjected = true;

  const PANEL_ID = 'bili-shuffle-panel';
  let boundVideos = new WeakSet();
  let lastUrl = location.href;
  let state = { active: false };

  /* ---------- 与后台通信 ---------- */
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(r);
        });
      } catch (e) {
        resolve({ error: String(e) });
      }
    });
  }

  function currentBvid() {
    const m = location.pathname.match(/\/(?:video|list)\/(BV[0-9A-Za-z]{10})/);
    if (m) return m[1];
    const u = new URLSearchParams(location.search).get('bvid');
    if (u && /^BV[0-9A-Za-z]{10}$/.test(u)) return u;
    if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.bvid) return window.__INITIAL_STATE__.bvid;
    return null;
  }

  /* ---------- 面板 ---------- */
  function ensurePanel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PANEL_ID;
    el.innerHTML = `
      <div class="bs-row bs-head">
        <span class="bs-dot"></span>
        <span class="bs-title">随机播放</span>
        <span class="bs-count" id="bs-count"></span>
        <button class="bs-btn" id="bs-collapse" title="收起">–</button>
      </div>
      <div class="bs-body">
        <div class="bs-now" id="bs-now"></div>
        <div class="bs-actions">
          <button class="bs-btn" id="bs-skip">跳过这个</button>
          <button class="bs-btn" id="bs-reshuffle">重新洗牌</button>
          <button class="bs-btn bs-ghost" id="bs-close">退出</button>
        </div>
      </div>
    `;
    (document.body || document.documentElement).appendChild(el);

    el.querySelector('#bs-collapse').addEventListener('click', (e) => {
      e.stopPropagation();
      el.classList.toggle('bs-collapsed');
      el.querySelector('#bs-collapse').textContent = el.classList.contains('bs-collapsed') ? '+' : '–';
    });
    el.querySelector('#bs-close').addEventListener('click', async (e) => {
      e.stopPropagation();
      await send({ type: 'clear' });
      render({ active: false });
    });
    el.querySelector('#bs-skip').addEventListener('click', async (e) => {
      e.stopPropagation();
      skip();
    });
    el.querySelector('#bs-reshuffle').addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await send({ type: 'reshuffle' });
      if (!r || r.error) return;
      refresh();
    });
    return el;
  }

  function fmtDur(s) {
    s = Number(s) || 0;
    if (!s) return '';
    const m = Math.floor(s / 60);
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    return m + ':' + ss;
  }

  function render(s) {
    state = s || { active: false };
    const el = document.getElementById(PANEL_ID);
    if (!state.active) {
      if (el) el.remove();
      return;
    }
    const p = ensurePanel();
    const count = p.querySelector('#bs-count');
    const now = p.querySelector('#bs-now');
    count.textContent = `${state.pos + 1}/${state.total}`;
    if (state.inQueue) {
      const nx = state.next;
      now.innerHTML = nx
        ? `下一个：<b>${escapeHtml(nx.title)}</b>${nx.duration ? ' <span class="bs-dur">' + fmtDur(nx.duration) + '</span>' : ''}`
        : '\u5df2\u7ecf\u662f\u6700\u540e\u4e00\u4e2a\u4e86';
    } else {
      now.innerHTML = '<span class="bs-warn">当前视频不在随机队列里</span>';
    }
    p.dataset.label = state.label || '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function refresh() {
    const bvid = currentBvid();
    if (!bvid) return;
    const r = await send({ type: 'status', bvid });
    if (!r || r.error) return;
    render(r);
  }

  async function skip() {
    const bvid = currentBvid();
    const r = await send({ type: 'advance', fromBvid: bvid });
    if (!r || r.error) return;
    if (r.done) {
      const p = document.getElementById(PANEL_ID);
      if (p) p.querySelector('#bs-now').innerHTML = '<span class="bs-warn">队列播完了，点「重新洗牌」再来一轮</span>';
      return;
    }
    goTo(r.item.bvid);
  }

  function goTo(bvid) {
    location.href = 'https://www.bilibili.com/video/' + bvid;
  }

  /* ---------- 播放结束 ---------- */
  // B 站自己的"自动连播"也会在结束时抢着跳。所以不等 ended，
  // 在剩 1.2 秒时就先跳，谁先跳谁说了算。
  const TAIL_SECONDS = 1.2;

  function isMainPlayer(v) {
    // 过滤掉预览小窗 / 广告位，只认版面够大的那个
    if (!v || v.tagName !== 'VIDEO') return false;
    const r = v.getBoundingClientRect();
    return r.width >= 320 && r.height >= 180;
  }

  function onEnded(video) {
    if (!state.active) return;
    if (state.settings && state.settings.autoNext === false) return;
    if (video.dataset.bsFired === '1') return;
    video.dataset.bsFired = '1';
    skip();
  }

  function checkTail(v) {
    if (!isMainPlayer(v)) return;
    if (v.paused || v.seeking) return;
    if (!v.duration || v.duration === Infinity) return;
    if (v.currentTime < 1) return;
    if (v.duration - v.currentTime > TAIL_SECONDS) return;
    onEnded(v);
  }

  function bindVideos() {
    for (const v of document.querySelectorAll('video')) {
      if (boundVideos.has(v)) continue;
      boundVideos.add(v);
      v.addEventListener('ended', () => onEnded(v));
      v.addEventListener('timeupdate', () => checkTail(v));
      // 换视频 / 重新播放时解锁
      v.addEventListener('play', () => { delete v.dataset.bsFired; });
      v.addEventListener('seeking', () => { delete v.dataset.bsFired; });
    }
  }

  /* ---------- 生命周期 ---------- */
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // 换视频了，解锁所有播放器的触发标记
      document.querySelectorAll('video').forEach((v) => { delete v.dataset.bsFired; });
      refresh();
    }
    bindVideos();
  }, 800);

  let renderTimer = null;
  function scheduleRefresh() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(refresh, 300);
  }

  // 初次
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bindVideos(); scheduleRefresh(); });
  } else {
    bindVideos();
    scheduleRefresh();
  }

  // 不监听整个 DOM：B 站弹幕/进度条一直在变，会导致每 300ms 发一次消息。
  // 只靠 URL 变化 + 初始加载 + 手动操作来刷新。
})();
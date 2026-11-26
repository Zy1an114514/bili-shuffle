# B站随机播放 · Bili Shuffle

**中文** | [English](README.en.md)

把 B 站收藏夹 / 稍后再看 / 合集 / 任意一串 BV 号**打乱成随机队列**，一个视频播完自动跳下一个。

Chrome / Edge 通用（Manifest V3），纯本地运行，不往任何服务器发数据。

---

## 为什么做这个

B 站官方的收藏夹连播是「顺序」的，合集的倒序/随机要另装插件，稍后再看更是只能一个个点。
这个插件只干一件事：**把列表洗牌，然后按洗好的顺序放**。

网上已有的同类（搜到的）：
- **Playlist for Bilibili**（[github.com/cqguo/playlist-for-bilibili](https://github.com/cqguo/playlist-for-bilibili)）——要自己建播放列表，再随机播
- **Bilibili Playlist Control**（[Chrome 商店](https://chromewebstore.google.com/detail/bilibili-playlist-control/daboeggiphdhiiacmbkbmacfehomkhom)）——合集倒序/随机
- **哔哩列表**——抓收藏夹做播放列表，作者已停止维护

它们要么要先手动建列表，要么只管合集。这个插件是「一键把现有收藏夹洗了直接开播」。

---

## 安装（开发者模式加载）

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选中本目录 `bili-shuffle-ext`
4. 装好后右上角会出现图标（蓝色圆角 + 洗牌箭头 + 播放三角）

也可以直接用打好的 `bili-shuffle-ext.zip`（解压后再加载，Chrome 不能直接拖 zip）。

> 首次安装建议先在一个 B 站标签页里登录好，插件读的是这个账号的收藏夹。

---

## 用法

点工具栏图标 → 弹窗里选一个来源：

| 来源 | 说明 |
|---|---|
| **收藏夹** | 下拉选一个自己的收藏夹，点「打乱」 |
| **稍后再看** | 一键打乱稍后再看列表 |
| **合集** | 粘贴 `space.bilibili.com/…/lists/…` 链接（新版合集，845 首这种也没问题），或在合集视频页里打乱 |
| **手动 BV** | 粘贴 BV 号 / 视频链接（空格、逗号、换行都能分隔），打乱这批 |

打乱后会自动新开标签页播放队列第一个。视频页右下角会出现一个小面板：

```
● 随机播放   3/57    –
下一个：某个视频标题  12:30
[跳过这个] [重新洗牌] [退出]
```

- **播完自动跳下一个**，不用管
- 面板上可以**跳过**、**重新洗牌**、**退出**（退出后回到普通播放，不干扰 B 站本身功能）
- 面板可以点 `–` 收起

弹窗里的设置：
- 播完最后一个后循环
- 每一轮重新洗牌（避免每次都是同一个顺序）
- 播完自动跳下一个（关掉就只洗牌不接管）
- **导入时按原顺序（不洗牌）**——想听歌单原本的顺序就勾这个

> 845 集的歌单队列约 157 KB，存在扩展本地存储里，完全没问题。

### 抢先跳的细节

B 站自己的「合集自动连播」也会在播完时抢着跳转。所以不是等 `ended`，而是**剩 1.2 秒时就先跳**，谁先跳谁说了算。同时只认版面够大的主播放器（≥320×180），预览小窗和广告位不会误触发。

---

## 实现要点

```
manifest.json      MV3 清单
background.js      service worker：调 B 站接口取数据 + 队列存取 + 下一集计算
content.js         视频页注入：右下角面板 + 监听 <video> 的 ended
content.css        面板样式
popup.html/js/css  弹窗 UI
rules.json         给 api.bilibili.com 补 Referer（否则部分接口 412）
icons/             16/32/48/128 图标
```

用到的官方接口（都是只读公开接口，带自己的 cookie）：
- `/x/web-interface/nav` — 拿 mid，判断登录
- `/x/v3/fav/folder/created/list-all` — 列出收藏夹
- `/x/v3/fav/resource/list` — 收藏夹内容（20 个一页翻完）
- `/x/v2/history/toview` — 稍后再看
- `/x/web-interface/view` — 视频信息 / 视频页内的 ugc_season 合集
- `/x/polymer/web-space/seasons_archives_list` — **新版合集**（space 页 lists/xxx，page_size=100 翻页，845 集约 2.8 秒抓完）

取数有两层：service worker 里直接 fetch；如果拿到 `-101 未登录`，会自动回退到在已打开的 B 站标签页里用页面自己的 cookie 再请求一次（`chrome.scripting.executeScript` + `world: 'MAIN'`）。这样后台 fetch 的 cookie 作用域问题不会误判成"没登录"。

两种合集的区别：
- **视频页内的合集**（`ugc_season`）：跟着单个视频走，一般几十集，不分页
- **space 页的合集**（`seasons_archives_list`）：UP 主自己建的合集，几百上千集，必须分页；B 站现在很多「歌单」「系列」都走这个

队列存在 `chrome.storage.local` 的 `bsQueue` 里，结构：

```js
{
  label: "收藏夹名",
  sourceUrl: "...",
  items: [{ bvid, title, cover, duration, upper }, ...],  // 已洗牌
  pos: 0,                                                 // 当前播到第几个
  createdAt: 1700000000000
}
```

换设备不同步（本来就是本地小工具）。

---

## 实测记录（2026-11-25）

在 Chrome 158 里用 CDP `Extensions.loadUnpacked` 真实装载，跑了一个 845 集的 UP 主合集（space 页 `lists/` 那种）：

- 845 集全部抓到，耗时 **2.8 秒**，队列 157 KB
- 真实 B 站视频页上面板正常渲染：`322/845`、`下一个：…`
- 洗牌不丢不重、循环回绕、每轮重洗、原顺序导入——全部通过

> 顺带一个坑：**Chrome 138+ 已经禁用了命令行 `--load-extension`**（我试了四种开关组合都没用），
> 自动化装载只能走 CDP 的 `Extensions.loadUnpacked`。手动安装不受影响，还是 `chrome://extensions` 那套。

## 已知边界

- **不处理分 P**：一个视频多个分 P 时，只播默认 P。合集里每一集是独立条目，没问题。
- **番剧/影视**走的是 `/bangumi/play/`，以 ep 为单位，不在本插件改造范围内（content script 会注入但队列按 BV 匹配，番剧页通常匹配不上）。
- 收藏夹里**已失效**的视频会被跳过（`attr === 9`）；被 UP 主删除、但接口仍返回的，跳过去会 404，这时点「跳过这个」。
- 播放器若被 B 站换成非 `<video>` 实现，自动跳转要靠手动点「跳过这个」。

---

## 卸载

`chrome://extensions/` → 找到「B站随机播放」→ 移除。
队列数据在扩展本地存储里，卸载即清空，不影响 B 站账号的任何内容。
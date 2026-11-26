# Bili Shuffle — random playlist for Bilibili

[中文](README.md) | **English**

A tiny Manifest V3 extension that **shuffles a Bilibili playlist into a random queue**
and keeps playing on its own. Works with favorites, Watch Later, UP-owner seasons
(hundreds of episodes), and any pasted list of BV ids.

Chrome / Edge. Runs entirely locally — nothing is sent anywhere.

---

## Why

Bilibili's built-in favorites autoplay is sequential, and their season autoplay
only goes forward. There was no one-click "shuffle this folder and just play".

Existing alternatives:
- [Playlist for Bilibili](https://github.com/cqguo/playlist-for-bilibili) — you build a playlist first, then shuffle it
- [Bilibili Playlist Control](https://chromewebstore.google.com/detail/bilibili-playlist-control/daboeggiphdhiiacmbkbmacfehomkhom) — reverse/shuffle a season only
- 哔哩列表 — favorites → playlist, unmaintained

None of them do "shuffle my existing favorites and start playing right now".

---

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

Chrome cannot load a `.zip` directly — unzip first.

Sign in to bilibili.com in the same browser before using favorites / Watch Later.

---

## Usage

Click the toolbar icon and pick a source:

| Source | What it does |
|---|---|
| **Favorites** | dropdown of your own folders → shuffle |
| **Watch Later** | shuffle the whole list |
| **Season** | paste a `space.bilibili.com/{mid}/lists/{sid}` link, or use the current video's `ugc_season` |
| **Manual** | paste BV ids / video links, separated by spaces, commas or newlines |

It shuffles, opens the first video in a new tab, and shows a small panel at the
bottom-right of the video page:

```
● 随机播放   3/57    –
下一个：some video title  12:30
[跳过这个] [重新洗牌] [退出]
```

- **Auto-advance** when a video ends
- Panel buttons: **skip**, **reshuffle**, **quit** (quit restores normal playback)
- Options: loop after the last one, reshuffle each round, disable auto-advance,
  and **keep original order** (import without shuffling)

---

## How it works

```
manifest.json      MV3 manifest
background.js      service worker: Bilibili API, queue storage, next-item logic
content.js         injected on video pages: panel + <video> ended detection
content.css        panel styles
popup.html/js/css  popup UI
rules.json         declarativeNetRequest: add Referer for api.bilibili.com
icons/             16/32/48/128
```

Read-only public endpoints used (with your own cookies):

- `/x/web-interface/nav` — mid / login check
- `/x/v3/fav/folder/created/list-all` — list favorite folders
- `/x/v3/fav/resource/list` — folder contents (20 per page)
- `/x/v2/history/toview` — Watch Later
- `/x/web-interface/view` — video info / in-video `ugc_season`
- `/x/polymer/web-space/seasons_archives_list` — **owner seasons** (space page
  `lists/xxx`, `page_size=100`; 845 episodes in ~2.8 s)

### Two layers of fetching

Bilibili returns `412 request was banned` when a request has no `buvid3` cookie
or Referer — and a service worker's `fetch` is exactly that kind of anonymous
caller. So the extension first runs the fetch **inside an already-open Bilibili
tab** (with that page's own cookies), and only falls back to a background fetch.
`rules.json` also sets a Referer through `declarativeNetRequest`.

### Beating Bilibili's own autoplay

Bilibili's season autoplay also jumps on `ended`. So the content script does not
wait for `ended` — it jumps at **1.2 seconds before the end**, whoever gets there
first wins. It only watches the main player (≥ 320×180), so preview thumbnails
and ad slots never trigger it.

Queue lives in `chrome.storage.local` under `bsQueue`:

```js
{
  label: "my playlist",
  sourceUrl: "...",
  items: [{ bvid, title, cover, duration, upper }, ...],  // already shuffled
  pos: 0,
  createdAt: 1700000000000
}
```

---

## Known limits

- **Multi-part (分P) videos** play the default part only. Each season episode is a
  separate entry, so seasons are fine.
- **Bangumi / movies** (`/bangumi/play/`) are out of scope.
- Deleted videos are skipped when Bilibili marks them invalid (`attr === 9`);
  if a deleted-but-still-listed one 404s, hit **skip**.

---

## Verified

Loaded for real in Chrome 158 through CDP `Extensions.loadUnpacked` against
an 845-episode owner season:

- 845/845 fetched in **2.8 s**, queue is 157 KB
- Panel renders on a real video page: `578/845`, `next: …`
- Shuffle loses nothing, loop wraps correctly, reshuffle each round, original-order import keeps order

> Note: **Chrome 138+ removed the `--load-extension` command-line flag**
> (four flag combinations tried, none work). Automated loading must go through
> CDP `Extensions.loadUnpacked`. Manual install is unaffected.

---

## Releasing

The repo ships a GitHub Actions workflow (`.github/workflows/release.yml`).
Pushing a tag builds and publishes the zip automatically:

```bash
# 1. bump "version" in manifest.json
# 2. tag and push
git tag v1.0.1
git push origin v1.0.1
```

It zips a clean extension package (excluding `.git`, `.github` and other
non-extension files) and attaches it to the matching release, with
GitHub's generated release notes.

You can also run it by hand from the Actions tab (`workflow_dispatch`);
leaving the tag input empty uses `v<manifest version>`.

---

## License

MIT
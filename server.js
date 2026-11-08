const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns').promises;
const multer = require('multer');
const { Readable } = require('stream');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const SUB_DIR = path.join(UPLOAD_DIR, 'subs');
const MAX_UPLOAD_GB = Number(process.env.MAX_UPLOAD_GB || 10);
// 语音聊天用的 STUN/TURN 服务器，JSON 数组，格式同 RTCPeerConnection 的 iceServers
let ICE_SERVERS = [{ urls: ['stun:stun.miwifi.com:3478', 'stun:stun.l.google.com:19302'] }];
try { if (process.env.ICE_SERVERS) ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('ICE_SERVERS 不是合法 JSON，已忽略'); }
// 视频网站链接解析服务（resolver/ 目录，docker compose 里的 resolver 容器）
const RESOLVER_URL = (process.env.RESOLVER_URL || '').replace(/\/+$/, '');
fs.mkdirSync(SUB_DIR, { recursive: true });

const SECRET = crypto.randomBytes(32); // 给中转的 m3u8 子链接签名，重启后失效
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

// ---------- 静态资源 ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/hls.js', express.static(require.resolve('hls.js/dist/hls.min.js')));
app.use('/vendor/mpegts.js', express.static(require.resolve('mpegts.js/dist/mpegts.js')));
app.use('/vendor/dash.js', express.static(require.resolve('dashjs/dist/dash.all.min.js')));
// 视频文件（express.static 默认支持 Range，可拖动进度条）
app.use('/uploads', express.static(UPLOAD_DIR, { acceptRanges: true }));

app.get('/api/config', (req, res) => res.json({ iceServers: ICE_SERVERS }));

// ---------- 上传 ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, crypto.randomBytes(8).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_GB * 1024 ** 3 },
  fileFilter: (req, file, cb) => cb(null, /^video\//.test(file.mimetype) || /\.(mp4|webm|mkv|mov|m4v|ogv|flv)$/i.test(file.originalname)),
});
app.post('/api/upload', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '不是有效的视频文件' });
    res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
  });
});

// ---------- 字幕上传：SRT / ASS / SSA / VTT 统一转成 WebVTT ----------
const subUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(srt|vtt|ass|ssa)$/i.test(file.originalname)),
});
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('gb18030').decode(buf); } catch {}
  return buf.toString('latin1');
}
function assTime(t) {
  const m = /(\d+):(\d+):(\d+)[.:](\d+)/.exec(t);
  if (!m) return null;
  const ms = String(Math.round(Number('0.' + m[4]) * 1000)).padStart(3, '0');
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${ms}`;
}
function toVtt(text, ext) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (ext === '.vtt') return /^WEBVTT/.test(text) ? text : 'WEBVTT\n\n' + text;
  if (ext === '.srt') {
    return 'WEBVTT\n\n' + text.replace(/^(\d+:\d+:\d+),(\d+)\s*-->\s*(\d+:\d+:\d+),(\d+)/gm, '$1.$2 --> $3.$4');
  }
  // ASS / SSA：只取对白文字，去掉特效标签
  let format = null;
  const cues = [];
  let inEvents = false;
  for (const line of text.split('\n')) {
    if (/^\[.*\]$/.test(line.trim())) { inEvents = /^\[events\]$/i.test(line.trim()); continue; }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) { format = line.slice(7).split(',').map((s) => s.trim().toLowerCase()); continue; }
    if (!/^Dialogue:/i.test(line) || !format) continue;
    const parts = line.slice(9).split(',');
    const textIdx = format.indexOf('text');
    const f = (k) => (parts[format.indexOf(k)] || '').trim();
    const start = assTime(f('start')), end = assTime(f('end'));
    if (!start || !end || textIdx < 0) continue;
    const body = parts.slice(textIdx).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();
    if (body) cues.push({ start, end, body });
  }
  cues.sort((a, b) => (a.start < b.start ? -1 : 1));
  return 'WEBVTT\n\n' + cues.map((c) => `${c.start} --> ${c.end}\n${c.body}\n`).join('\n');
}
app.post('/api/subtitle', (req, res) => {
  subUpload.single('subtitle')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '只支持 .srt / .ass / .ssa / .vtt 字幕文件' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const vtt = toVtt(decodeText(req.file.buffer), ext === '.ssa' ? '.ass' : ext);
    const file = crypto.randomBytes(8).toString('hex') + '.vtt';
    fs.writeFileSync(path.join(SUB_DIR, file), vtt);
    res.json({ url: '/uploads/subs/' + file, name: req.file.originalname });
  });
});

// ---------- 公开房间列表（首页大厅） ----------
app.get('/api/rooms', (req, res) => {
  const list = [...rooms.values()]
    .filter((r) => r.public && r.users.size > 0)
    .map((r) => ({
      id: r.id, name: r.name, online: r.users.size, locked: !!r.passHash,
      title: r.passHash ? '' : (r.cur && r.cur.title) || '', playing: r.playing,
    }))
    .sort((a, b) => b.online - a.online)
    .slice(0, 100);
  res.json(list);
});

// ---------- SSRF 防护 ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  // 不拦截 fc00::/7：很多代理（fake-ip 模式）会把公网域名解析到这个段
  return v === '::1' || v === '::' || v.startsWith('fe80');
}
async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http/https 链接');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('不允许访问内网地址');
}

// 视频条目上可选的自定义请求头（防盗链 Referer、Cookie 等），只保存在服务器，不下发给其他成员
const HEADER_WHITELIST = ['referer', 'origin', 'user-agent', 'cookie', 'authorization'];
function cleanHeaders(h) {
  if (!h || typeof h !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const key = String(k).trim().toLowerCase();
    if (!HEADER_WHITELIST.includes(key)) continue;
    const val = String(v || '').replace(/[\r\n]/g, '').trim().slice(0, 2000);
    if (val) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}
// 跟随重定向发请求；每一跳都检查内网地址，跨域跳转时不再带 Cookie / Authorization
async function fetchFollow(url, baseHeaders, signal, max = 6) {
  const origin = url.origin;
  for (let i = 0; i < max; i++) {
    await assertPublic(url);
    const headers = { ...baseHeaders };
    if (url.origin !== origin) { delete headers.cookie; delete headers.authorization; }
    const r = await fetch(url, { redirect: 'manual', headers, signal });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { r.body?.cancel(); url = new URL(loc, url); continue; }
    return { r, url };
  }
  throw new Error('重定向次数过多');
}
const findRoomBySrc = (src) => [...rooms.values()].find((r) => r.cur && r.cur.src === src);

// ---------- 链接诊断：播放失败时由前端调用，找出失败原因 ----------
app.get('/api/probe', async (req, res) => {
  let url;
  const src = String(req.query.url || '');
  try { url = new URL(src); } catch { return res.json({ ok: false, reason: '链接格式不正确' }); }
  const room = rooms.get(String(req.query.room || ''));
  const extra = room && room.cur && room.cur.src === src ? room.cur.headers || {} : {};
  const hops = [];
  try {
    for (let i = 0; i < 6; i++) {
      await assertPublic(url);
      const headers = { 'user-agent': 'Mozilla/5.0 (mm0-video link probe)', ...extra, range: 'bytes=0-1023' };
      if (i > 0 && url.origin !== new URL(src).origin) { delete headers.cookie; delete headers.authorization; }
      const r = await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(10000) });
      const loc = r.headers.get('location');
      hops.push({ status: r.status, host: url.hostname });
      if (r.status >= 300 && r.status < 400 && loc) { r.body?.cancel(); url = new URL(loc, url); continue; }
      const type = (r.headers.get('content-type') || '').split(';')[0].trim();
      let body = '';
      if (r.status >= 400 || /json|html|text/.test(type)) body = (await r.text()).slice(0, 200);
      else r.body?.cancel();
      return res.json({
        ok: r.status < 400, status: r.status, contentType: type, hops,
        range: r.status === 206 || r.headers.get('accept-ranges') === 'bytes',
        cors: r.headers.get('access-control-allow-origin'),
        finalHost: url.hostname, body,
      });
    }
    res.json({ ok: false, reason: '重定向次数过多', hops });
  } catch (e) {
    res.json({ ok: false, reason: e.name === 'TimeoutError' ? '服务器连接该链接超时' : '服务器无法访问该链接：' + (e.cause?.code || e.message), hops });
  }
});

// ---------- 视频中转 ----------
// 1. 给 Safari / iOS / 微信等浏览器修正文件类型（网盘 CDN 常返回 octet-stream + 下载附件头）
// 2. 带上自定义请求头（Referer / Cookie 等）访问有防盗链的视频
// 3. m3u8 会被改写，里面的分片 / 子列表也走中转（解决跨域 CORS 问题）
// 只允许中转房间正在播放的链接，或由服务器签名过的 m3u8 子链接，避免被当成公开代理。
const EXT_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska', '.flv': 'video/x-flv', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment',
};
function sign(roomId, itemId, url) {
  return crypto.createHmac('sha256', SECRET).update(`${roomId}\n${itemId}\n${url}`).digest('base64url').slice(0, 22);
}
function proxyPath(room, url) {
  return `/api/stream?room=${encodeURIComponent(room.id)}&url=${encodeURIComponent(url)}&sig=${sign(room.id, room.cur.id, url)}`;
}
function rewriteM3u8(text, base, room) {
  const abs = (u) => { try { return new URL(u, base).href; } catch { return u; } };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${proxyPath(room, abs(u))}"`);
    return proxyPath(room, abs(t));
  }).join('\n');
}
const itemHeaders = (item) => (item.media ? item.media.headers : item.headers) || {};
app.get('/api/stream', async (req, res) => {
  const src = String(req.query.url || '');
  const room = req.query.room ? rooms.get(String(req.query.room)) : findRoomBySrc(src);
  if (!room || !room.cur) return res.status(403).send('只能中转房间里正在播放的视频');
  const sig = String(req.query.sig || '');
  const expect = sign(room.id, room.cur.id, src);
  const allowed = (!room.cur.media && room.cur.src === src) || (sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)));
  if (!allowed) return res.status(403).send('只能中转房间里正在播放的视频');
  proxyMedia(req, res, room, src, itemHeaders(room.cur));
});
async function proxyMedia(req, res, room, src, extraHeaders) {
  let url;
  try { url = new URL(src); } catch { return res.status(400).send('链接格式不正确'); }
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const headers = { 'user-agent': req.get('user-agent') || 'Mozilla/5.0', 'accept-encoding': 'identity', ...extraHeaders };
    if (req.get('range')) headers.range = req.get('range');
    const { r, url: finalUrl } = await fetchFollow(url, headers, ac.signal);
    let type = (r.headers.get('content-type') || '').split(';')[0].trim();
    const name = decodeURIComponent(url.pathname) + ' ' + (finalUrl.searchParams.get('filename') || '');
    // 只有类型是 mpegurl、或路径以 .m3u8 结尾才可能是播放列表（YouTube 的分片路径中间也带 .m3u8，不能用包含判断）
    const maybeM3u8 = /mpegurl/i.test(type) || (/\.m3u8$/i.test(finalUrl.pathname) && !/^(video|audio)\//.test(type));
    if (maybeM3u8 && r.status < 400 && !req.get('range')) {
      const buf = Buffer.from(await r.arrayBuffer());
      res.set('Cache-Control', 'no-store');
      if (buf.length < 20 * 1024 * 1024 && buf.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) {
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(rewriteM3u8(buf.toString('utf8'), finalUrl, room));
      }
      // 不是真正的播放列表：原样返回
      res.status(r.status).set('Content-Type', type || 'application/octet-stream');
      return res.send(buf);
    }
    if (!/^video\//.test(type)) {
      const ext = (name.match(/\.(mp4|m4v|mov|webm|ogv|mkv|flv|ts|m4s)\b/i) || [])[0];
      type = EXT_TYPES[(ext || '.mp4').toLowerCase()];
    }
    res.status(r.status);
    res.set('Content-Type', type);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'no-store');
    for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
      const v = r.headers.get(h); if (v) res.set(h, v);
    }
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).send('中转失败：' + (e.cause?.code || e.message));
    else res.destroy();
  }
}

// ---------- 网页链接解析（B 站 / YouTube / 抖音 等） ----------
// 解析出来的媒体地址会过期，所以房间里保存的是网页地址，播放时走 /api/play/<房间>/<条目>.<类型>，
// 由服务器按需重新解析，再跳转或中转到真实地址。
const RESOLVE_HOSTS = /(^|\.)(bilibili\.com|b23\.tv|bili2233\.cn|youtube\.com|youtu\.be|douyin\.com|iesdouyin\.com|ixigua\.com|kuaishou\.com|acfun\.cn|tiktok\.com|twitch\.tv|vimeo\.com|weibo\.com|weibo\.cn|x\.com|twitter\.com|dailymotion\.com|nicovideo\.jp)$/i;
const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|ogv|flv|m3u8|mpd|ts)$/i;
function shouldResolve(src, force) {
  let u; try { u = new URL(src); } catch { return false; }
  if (!/^https?:$/.test(u.protocol) || MEDIA_EXT.test(u.pathname)) return false;
  return !!force || RESOLVE_HOSTS.test(u.hostname);
}
async function callResolver(page) {
  if (!RESOLVER_URL) throw new Error('服务器没有配置解析服务（RESOLVER_URL），请用 docker compose 部署');
  let r;
  try { r = await fetch(`${RESOLVER_URL}/resolve?url=${encodeURIComponent(page)}`, { signal: AbortSignal.timeout(90000) }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? '解析超时，请稍后重试' : '连接不上解析服务，请确认 mm0-resolver 容器在运行'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `解析服务出错（${r.status}）`);
  return j;
}
// 媒体地址快过期（剩 5 分钟内）就重新解析；同一条目并发请求只解析一次
async function ensureMedia(item) {
  const m = item.media;
  if (m && m.expires_at * 1000 - Date.now() > 5 * 60 * 1000) return m;
  if (!item.resolving) {
    item.resolving = callResolver(item.src).then((res) => (item.media = res)).finally(() => { item.resolving = null; });
  }
  return item.resolving;
}
const playExt = (m) => ({ hls: 'm3u8', 'hls-split': 'm3u8', dash: 'mpd' }[m.kind] || m.ext || 'mp4');
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// YouTube：视频 m3u8 + 音频 m3u8 组合成一个 HLS 主播放列表（hls.js / Safari 都支持独立音轨）
function buildMaster(room, m) {
  const lines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="${proxyPath(room, m.audio.url)}"`];
  for (const v of m.video) {
    const codecs = v.codecs ? `,CODECS="${v.codecs},${m.audio.codecs || 'mp4a.40.2'}"` : '';
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth || 1000000}${v.width ? `,RESOLUTION=${v.width}x${v.height}` : ''}${codecs},AUDIO="aud"`);
    lines.push(proxyPath(room, v.url));
  }
  return lines.join('\n') + '\n';
}
// B 站高画质：音视频分轨的 mp4，生成 DASH 描述文件交给 dash.js，分片经服务器中转（CDN 校验 Referer）
function buildMpd(room, m) {
  const rep = (x, i, kind) => `
      <Representation id="${kind}${i}" bandwidth="${x.bandwidth || 1}" codecs="${xmlEsc(x.codecs || '')}"${x.width ? ` width="${x.width}" height="${x.height}"` : ''}${x.frame_rate ? ` frameRate="${xmlEsc(x.frame_rate)}"` : ''}>
        <BaseURL>${xmlEsc(proxyPath(room, x.url))}</BaseURL>
        <SegmentBase indexRange="${xmlEsc(x.index)}"><Initialization range="${xmlEsc(x.init)}"/></SegmentBase>
      </Representation>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT${Number(m.duration) || 0}S" minBufferTime="PT1.5S">
  <Period>
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">${m.video.map((x, i) => rep(x, i, 'v')).join('')}
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">${m.audio.map((x, i) => rep(x, i, 'a')).join('')}
    </AdaptationSet>
  </Period>
</MPD>
`;
}
app.get('/api/play/:room/:file', async (req, res) => {
  const room = rooms.get(req.params.room);
  const itemId = req.params.file.split('.')[0];
  if (!room || !room.cur || room.cur.id !== itemId || !room.cur.media) return res.status(404).send('这个视频已经不是房间正在播放的视频了');
  const item = room.cur;
  let m;
  try { m = await ensureMedia(item); } catch (e) { return res.status(502).send('解析失败：' + e.message); }
  if (room.cur !== item) return res.status(404).send('这个视频已经不是房间正在播放的视频了');
  res.set('Cache-Control', 'no-store');
  if (m.kind === 'hls-split') return res.type('application/vnd.apple.mpegurl').send(buildMaster(room, m));
  if (m.kind === 'dash') return res.type('application/dash+xml').send(buildMpd(room, m));
  // 浏览器能直接访问的（如 B 站 mp4）就跳转过去，不占服务器流量；播放失败时前端会带 ?proxy=1 改走中转
  if (m.kind === 'file' && m.direct && req.query.proxy !== '1') return res.redirect(302, m.url);
  proxyMedia(req, res, room, m.url, m.headers || {});
});

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/r/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

// ---------- 房间 ----------
const rooms = new Map();
const MODES = ['order', 'loop', 'one', 'shuffle']; // 顺序 / 列表循环 / 单集循环 / 随机
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const hashPass = (p) => crypto.createHash('sha256').update('mm0:' + p).digest('hex');
const newId = () => crypto.randomBytes(6).toString('hex');
const clean = (s, n) => String(s || '').slice(0, n);

function createRoom(id, ownerUid) {
  const r = {
    id, name: '', public: false, passHash: '', controlMode: 'all', ownerUid, admins: new Set(),
    cur: null, playing: false, time: 0, rate: 1, updatedAt: Date.now(), changedAt: 0,
    playlist: [], mode: 'order', history: [], messages: [], users: new Map(), voice: new Set(), bans: new Map(),
  };
  rooms.set(id, r);
  return r;
}
function currentTime(r) {
  return r.playing ? r.time + ((Date.now() - r.updatedAt) / 1000) * r.rate : r.time;
}
function snapshot(r) {
  const c = r.cur || {};
  return {
    src: c.media ? `/api/play/${encodeURIComponent(r.id)}/${c.id}.${playExt(c.media)}` : c.src || '',
    page: c.media ? c.src : '', live: !!(c.media && c.media.is_live),
    title: c.title || '', itemId: c.id || '', subtitle: c.subtitle || null, proxy: !!c.headers,
    playing: r.playing, time: currentTime(r), rate: r.rate, serverNow: Date.now(),
  };
}
const publicItem = (i) => ({ id: i.id, src: i.src, title: i.title, hasHeaders: !!i.headers, hasSubtitle: !!i.subtitle, resolved: !!i.media });
function roomInfo(r) {
  return {
    name: r.name, public: r.public, hasPassword: !!r.passHash, controlMode: r.controlMode, mode: r.mode,
    playlist: r.playlist.map(publicItem), history: r.history.map(publicItem),
  };
}
function roleOf(r, uid) { return uid === r.ownerUid ? 'owner' : r.admins.has(uid) ? 'admin' : 'member'; }
function userList(r) {
  return [...r.users.entries()].map(([sid, u]) => ({ sid, name: u.name, role: roleOf(r, u.uid), voice: r.voice.has(sid) }));
}
const emitState = (r) => io.to(r.id).emit('state', snapshot(r));
const emitInfo = (r) => io.to(r.id).emit('room', roomInfo(r));
const emitUsers = (r) => io.to(r.id).emit('users', userList(r));
function systemMsg(r, text) {
  const m = { system: true, text, t: Date.now() };
  r.messages.push(m); if (r.messages.length > 100) r.messages.shift();
  io.to(r.id).emit('chat', m);
}

function playItem(r, item, autoplay) {
  r.cur = { ...item };
  Object.assign(r, { playing: !!autoplay, time: 0, updatedAt: Date.now(), changedAt: Date.now() });
  r.history = [item, ...r.history.filter((h) => h.src !== item.src)].slice(0, 30);
}
function advance(r) {
  const list = r.playlist;
  if (r.mode === 'one' || !list.length) {
    if (r.mode === 'one' && r.cur) return Object.assign(r, { playing: true, time: 0, updatedAt: Date.now(), changedAt: Date.now() });
    return Object.assign(r, { playing: false, time: currentTime(r), updatedAt: Date.now() });
  }
  const idx = r.cur ? list.findIndex((i) => i.id === r.cur.id) : -1;
  let next;
  if (r.mode === 'shuffle') {
    const others = list.filter((i) => !r.cur || i.id !== r.cur.id);
    next = others.length ? others[Math.floor(Math.random() * others.length)] : list[0];
  } else if (idx + 1 < list.length) next = list[idx + 1];
  else if (r.mode === 'loop') next = list[0];
  if (!next) return Object.assign(r, { playing: false, time: currentTime(r), updatedAt: Date.now() });
  playItem(r, next, true);
}
function makeItem({ src, title, headers }) {
  src = clean(src, 2000).trim();
  if (!/^(https?:\/\/|\/uploads\/)/i.test(src)) return null;
  return { id: newId(), src, title: clean(title, 100) || decodeURIComponent(src.split('/').pop().split('?')[0]).slice(0, 100), headers: /^https?:/i.test(src) ? cleanHeaders(headers) : null, subtitle: null };
}

io.on('connection', (socket) => {
  let r = null;      // 当前房间
  let uid = '';      // 客户端持久身份（localStorage），用于识别房主/管理员
  const role = () => (r ? roleOf(r, uid) : 'member');
  const canControl = () => r && (r.controlMode === 'all' || role() !== 'member');
  const canManage = () => r && role() !== 'member';
  const deny = (text) => socket.emit('notice', text);

  socket.on('join', ({ room, name, uid: u, password, create } = {}, ack) => {
    if (typeof ack !== 'function' || r) return;
    const id = clean(room, 40).replace(/[^\w-]/g, '');
    if (!id) return ack({ error: 'bad' });
    uid = /^[\w-]{8,64}$/.test(String(u || '')) ? String(u) : 'anon-' + socket.id;
    let room_ = rooms.get(id);
    if (!room_) {
      room_ = createRoom(id, uid);
      if (create && typeof create === 'object') {
        room_.name = clean(create.name, 40).trim();
        room_.public = !!create.public;
        if (create.password) room_.passHash = hashPass(clean(create.password, 64));
      }
    }
    const ban = room_.bans.get(uid);
    if (ban && ban > Date.now()) return ack({ error: 'kicked', wait: Math.ceil((ban - Date.now()) / 60000) });
    if (room_.passHash && roleOf(room_, uid) === 'member' && hashPass(clean(password, 64)) !== room_.passHash) {
      return ack({ error: password ? 'wrongPassword' : 'password', name: room_.name });
    }
    r = room_;
    const nick = clean(name, 20).trim() || '游客' + socket.id.slice(0, 4);
    r.users.set(socket.id, { name: nick, uid });
    socket.join(r.id);
    ack({ state: snapshot(r), info: roomInfo(r), users: userList(r), me: nick, sid: socket.id, messages: r.messages });
    socket.to(r.id).emit('users', userList(r));
    systemMsg(r, `${nick} 加入了房间`);
  });

  // 添加视频（可选立即播放）
  socket.on('pl:add', async (data = {}) => {
    if (!r) return;
    if (!canControl()) return deny('房主设置了仅房主和管理员可以换视频');
    const item = makeItem(data);
    if (!item) return deny('链接格式不正确');
    if (r.playlist.length >= 200) return deny('播放列表最多 200 个视频');
    if (shouldResolve(item.src, data.resolve)) {
      const room = r;
      socket.emit('notice', '正在解析视频链接…');
      try {
        item.media = await callResolver(item.src);
      } catch (e) {
        return socket.emit('resolveError', e.message);
      }
      if (rooms.get(room.id) !== room || r !== room) return;
      item.headers = null; // 解析出的请求头保存在 media 里
      if (!data.title) item.title = clean(item.media.title, 100) || item.title;
      socket.emit('notice', `解析成功：${item.title}`);
    }
    r.playlist.push(item);
    if (data.play || !r.cur) { playItem(r, item, false); emitState(r); }
    emitInfo(r);
  });
  // 兼容旧客户端
  socket.on('setSource', (data = {}) => socket.listeners('pl:add')[0]({ ...data, play: true }));

  socket.on('pl:play', ({ id } = {}) => {
    if (!r) return;
    if (!canControl()) return deny('房主设置了仅房主和管理员可以换视频');
    const item = r.playlist.find((i) => i.id === id) || r.history.find((i) => i.id === id);
    if (!item) return;
    if (!r.playlist.some((i) => i.id === item.id)) r.playlist.push(item); // 从历史记录重新播放
    playItem(r, item, false);
    emitState(r); emitInfo(r);
  });
  socket.on('pl:next', () => {
    if (!r || !r.cur) return;
    if (!canControl()) return deny('房主设置了仅房主和管理员可以控制播放');
    const mode = r.mode; if (mode === 'one') r.mode = 'loop';
    advance(r); r.mode = mode;
    emitState(r); emitInfo(r);
  });
  socket.on('pl:remove', ({ id } = {}) => {
    if (!r || !canControl()) return deny('没有权限');
    r.playlist = r.playlist.filter((i) => i.id !== id);
    emitInfo(r);
  });
  socket.on('pl:move', ({ id, dir } = {}) => {
    if (!r || !canControl()) return deny('没有权限');
    const i = r.playlist.findIndex((x) => x.id === id), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= r.playlist.length) return;
    [r.playlist[i], r.playlist[j]] = [r.playlist[j], r.playlist[i]];
    emitInfo(r);
  });
  socket.on('pl:clear', () => {
    if (!r || !canControl()) return deny('没有权限');
    r.playlist = r.cur ? r.playlist.filter((i) => i.id === r.cur.id) : [];
    emitInfo(r);
  });
  socket.on('pl:mode', (mode) => {
    if (!r || !canControl()) return deny('没有权限');
    if (!MODES.includes(mode)) return;
    r.mode = mode; emitInfo(r);
  });
  // 有人播完了：按播放顺序切到下一个（多人同时上报只处理一次）
  socket.on('ended', ({ itemId } = {}) => {
    if (!r || !r.cur || r.cur.id !== itemId || !r.playing) return;
    if (Date.now() - r.changedAt < 5000) return;
    advance(r);
    emitState(r); emitInfo(r);
  });

  // 字幕：挂到当前视频上，所有人同步加载
  socket.on('subtitle', (sub) => {
    if (!r || !r.cur) return;
    if (!canControl()) return deny('没有权限');
    let val = null;
    if (sub && /^\/uploads\/subs\/[a-f0-9]{16}\.vtt$/.test(sub.url)) val = { url: sub.url, label: clean(sub.label, 60) || '字幕' };
    r.cur.subtitle = val;
    const it = r.playlist.find((i) => i.id === r.cur.id); if (it) it.subtitle = val;
    const h = r.history.find((i) => i.id === r.cur.id); if (h) h.subtitle = val;
    emitState(r); emitInfo(r);
  });

  // 播放/暂停/跳转/倍速
  socket.on('control', ({ type, time, rate } = {}) => {
    if (!r) return;
    if (!canControl()) { socket.emit('state', snapshot(r)); return deny('房主设置了仅房主和管理员可以控制播放'); }
    time = Number(time); if (!Number.isFinite(time) || time < 0) time = currentTime(r);
    if (type === 'play') r.playing = true;
    else if (type === 'pause') r.playing = false;
    else if (type === 'seek') { /* 保持当前播放状态 */ }
    else if (type === 'rate') r.rate = RATES.includes(Number(rate)) ? Number(rate) : 1;
    else return;
    r.time = time; r.updatedAt = Date.now();
    socket.to(r.id).emit('state', snapshot(r));
  });

  socket.on('getState', (ack) => { r && typeof ack === 'function' && ack(snapshot(r)); });

  socket.on('chat', (text) => {
    if (!r) return;
    text = clean(text, 500).trim(); if (!text) return;
    const m = { name: r.users.get(socket.id).name, sid: socket.id, text, t: Date.now() };
    r.messages.push(m); if (r.messages.length > 100) r.messages.shift();
    io.to(r.id).emit('chat', m);
  });

  // ---------- 房间管理 ----------
  socket.on('settings', (s = {}) => {
    if (!r) return;
    if (!canManage()) return deny('只有房主和管理员可以修改房间设置');
    if (typeof s.name === 'string') r.name = clean(s.name, 40).trim();
    if (typeof s.public === 'boolean') r.public = s.public;
    if (['all', 'admins'].includes(s.controlMode)) r.controlMode = s.controlMode;
    if (typeof s.password === 'string') r.passHash = s.password ? hashPass(clean(s.password, 64)) : '';
    emitInfo(r);
    systemMsg(r, `${r.users.get(socket.id).name} 修改了房间设置`);
  });
  const target = (sid) => (r && r.users.has(sid) ? r.users.get(sid) : null);
  socket.on('kick', ({ sid } = {}) => {
    const t = target(sid); if (!t || sid === socket.id) return;
    const mine = role(), theirs = roleOf(r, t.uid);
    if (mine === 'member' || theirs === 'owner' || (mine === 'admin' && theirs === 'admin')) return deny('没有权限踢出该成员');
    r.bans.set(t.uid, Date.now() + 5 * 60 * 1000);
    const s = io.sockets.sockets.get(sid);
    if (s) { s.emit('kicked', '你被移出了房间（5 分钟内不能重新加入）'); s.disconnect(true); }
    systemMsg(r, `${t.name} 被移出了房间`);
  });
  socket.on('setAdmin', ({ sid, admin } = {}) => {
    const t = target(sid); if (!t) return;
    if (role() !== 'owner') return deny('只有房主可以设置管理员');
    if (t.uid === r.ownerUid) return;
    if (admin) r.admins.add(t.uid); else r.admins.delete(t.uid);
    emitUsers(r);
    systemMsg(r, admin ? `${t.name} 成为了管理员` : `${t.name} 不再是管理员`);
  });
  socket.on('transfer', ({ sid } = {}) => {
    const t = target(sid); if (!t || sid === socket.id) return;
    if (role() !== 'owner') return deny('只有房主可以转让房间');
    r.admins.add(r.ownerUid); r.admins.delete(t.uid);
    r.ownerUid = t.uid;
    emitUsers(r);
    systemMsg(r, `房主转让给了 ${t.name}`);
  });

  // ---------- 语音聊天（WebRTC 网状连接，服务器只转发信令） ----------
  socket.on('voice:join', (ack) => {
    if (!r || typeof ack !== 'function') return;
    const peers = [...r.voice].filter((s) => s !== socket.id);
    if (peers.length >= 8) return ack({ error: '语音人数已满（最多 8 人）' });
    r.voice.add(socket.id);
    ack({ peers });
    emitUsers(r);
  });
  socket.on('voice:leave', () => {
    if (!r || !r.voice.delete(socket.id)) return;
    socket.to(r.id).emit('voice:left', socket.id);
    emitUsers(r);
  });
  socket.on('voice:signal', ({ to, data } = {}) => {
    if (!r || !r.voice.has(socket.id) || !r.voice.has(to)) return;
    io.to(to).emit('voice:signal', { from: socket.id, data });
  });

  socket.on('ping_t', (ack) => typeof ack === 'function' && ack(Date.now()));

  socket.on('disconnect', () => {
    if (!r) return;
    const u = r.users.get(socket.id);
    r.users.delete(socket.id);
    if (r.voice.delete(socket.id)) socket.to(r.id).emit('voice:left', socket.id);
    const room = r;
    if (room.users.size === 0) {
      setTimeout(() => { if (rooms.get(room.id) === room && room.users.size === 0) rooms.delete(room.id); }, 10 * 60 * 1000);
    } else {
      emitUsers(room);
      systemMsg(room, `${u.name} 离开了房间`);
    }
  });
});

server.listen(PORT, () => console.log(`Watch Together listening on :${PORT}`));

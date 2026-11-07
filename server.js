const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns').promises;
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const MAX_UPLOAD_GB = Number(process.env.MAX_UPLOAD_GB || 10);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

// ---------- 静态资源 ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/hls.js', express.static(require.resolve('hls.js/dist/hls.min.js')));
// 视频文件（express.static 默认支持 Range，可拖动进度条）
app.use('/uploads', express.static(UPLOAD_DIR, { acceptRanges: true }));

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
  fileFilter: (req, file, cb) => cb(null, /^video\//.test(file.mimetype) || /\.(mp4|webm|mkv|mov|m4v|ogv)$/i.test(file.originalname)),
});
app.post('/api/upload', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '不是有效的视频文件' });
    res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
  });
});

// ---------- 链接诊断：播放失败时由前端调用，找出失败原因 ----------
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
app.get('/api/probe', async (req, res) => {
  let url;
  try { url = new URL(String(req.query.url || '')); } catch { return res.json({ ok: false, reason: '链接格式不正确' }); }
  const hops = [];
  try {
    for (let i = 0; i < 6; i++) {
      await assertPublic(url);
      const r = await fetch(url, {
        redirect: 'manual',
        headers: { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0 (mm0-video link probe)' },
        signal: AbortSignal.timeout(10000),
      });
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

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/r/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

// ---------- 房间同步 ----------
const rooms = new Map(); // id -> {src,title,playing,time,rate,updatedAt,users:Map}

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { src: '', title: '', playing: false, time: 0, rate: 1, updatedAt: Date.now(), users: new Map() });
  }
  return rooms.get(id);
}
function currentTime(r) {
  return r.playing ? r.time + ((Date.now() - r.updatedAt) / 1000) * r.rate : r.time;
}
function snapshot(r) {
  return { src: r.src, title: r.title, playing: r.playing, time: currentTime(r), rate: r.rate, serverNow: Date.now() };
}
const clean = (s, n) => String(s || '').slice(0, n);

io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join', ({ room, name }, ack) => {
    roomId = clean(room, 40).replace(/[^\w-]/g, '');
    if (!roomId) return;
    const r = getRoom(roomId);
    const nick = clean(name, 20) || '游客' + socket.id.slice(0, 4);
    r.users.set(socket.id, nick);
    socket.join(roomId);
    ack && ack({ state: snapshot(r), users: [...r.users.values()], me: nick });
    socket.to(roomId).emit('users', [...r.users.values()]);
    socket.to(roomId).emit('chat', { system: true, text: `${nick} 加入了房间` });
  });

  // 换视频
  socket.on('setSource', ({ src, title }) => {
    const r = rooms.get(roomId); if (!r) return;
    src = clean(src, 2000);
    if (!/^(https?:\/\/|\/uploads\/)/i.test(src)) return;
    Object.assign(r, { src, title: clean(title, 100), playing: false, time: 0, updatedAt: Date.now() });
    io.to(roomId).emit('state', snapshot(r));
  });

  // 播放/暂停/跳转/倍速
  socket.on('control', ({ type, time, rate }) => {
    const r = rooms.get(roomId); if (!r) return;
    time = Number(time); if (!Number.isFinite(time) || time < 0) time = currentTime(r);
    if (type === 'play') r.playing = true;
    else if (type === 'pause') r.playing = false;
    else if (type === 'seek') { /* 保持当前播放状态 */ }
    else if (type === 'rate') r.rate = [0.5, 0.75, 1, 1.25, 1.5, 2].includes(Number(rate)) ? Number(rate) : 1;
    else return;
    r.time = time; r.updatedAt = Date.now();
    socket.to(roomId).emit('state', snapshot(r));
  });

  socket.on('getState', (ack) => { const r = rooms.get(roomId); r && ack && ack(snapshot(r)); });

  socket.on('chat', (text) => {
    const r = rooms.get(roomId); if (!r) return;
    text = clean(text, 500).trim(); if (!text) return;
    io.to(roomId).emit('chat', { name: r.users.get(socket.id), text });
  });

  socket.on('ping_t', (ack) => ack && ack(Date.now()));

  socket.on('disconnect', () => {
    const r = rooms.get(roomId); if (!r) return;
    const nick = r.users.get(socket.id);
    r.users.delete(socket.id);
    if (r.users.size === 0) { setTimeout(() => { const x = rooms.get(roomId); if (x && x.users.size === 0) rooms.delete(roomId); }, 10 * 60 * 1000); }
    else {
      io.to(roomId).emit('users', [...r.users.values()]);
      io.to(roomId).emit('chat', { system: true, text: `${nick} 离开了房间` });
    }
  });
});

server.listen(PORT, () => console.log(`Watch Together listening on :${PORT}`));

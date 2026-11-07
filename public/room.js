(() => {
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const roomId = decodeURIComponent(location.pathname.split('/').pop());
  $('roomLabel').textContent = roomId;

  let name = '';
  try { name = localStorage.getItem('wt_name') || ''; } catch {}
  if (!name) {
    name = (prompt('请输入你的昵称') || '').trim();
    try { localStorage.setItem('wt_name', name); } catch {}
  }

  const socket = io();
  let clockOffset = 0;          // 服务器时间 - 本地时间
  let currentSrc = '';
  let hls = null;
  let suppressUntil = 0;        // 应用远端状态期间屏蔽本地事件回传
  let lastState = null;

  // ---------- 时钟校准 ----------
  function syncClock() {
    const t0 = Date.now();
    socket.emit('ping_t', (serverNow) => {
      const t1 = Date.now();
      clockOffset = serverNow - (t0 + t1) / 2;
    });
  }

  // ---------- 载入视频 ----------
  function loadSource(src) {
    if (src === currentSrc) return;
    currentSrc = src;
    if (hls) { hls.destroy(); hls = null; }
    $('empty').classList.toggle('hidden', !!src);
    if (!src) { video.removeAttribute('src'); video.load(); return; }
    if (/\.m3u8(\?|$)/i.test(src) && !video.canPlayType('application/vnd.apple.mpegurl') && window.Hls && Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = src;
    }
  }

  function targetTime(s) {
    if (!s.playing) return s.time;
    const elapsed = (Date.now() + clockOffset - s.serverNow) / 1000;
    return s.time + Math.max(0, elapsed) * s.rate;
  }

  // ---------- 应用远端状态 ----------
  function applyState(s, force = false) {
    lastState = s;
    suppressUntil = Date.now() + 800;
    loadSource(s.src);
    $('title').textContent = s.title || '';
    if (!s.src) return;
    if (video.playbackRate !== s.rate) video.playbackRate = s.rate;
    const t = targetTime(s);
    if (force || Math.abs(video.currentTime - t) > 1) {
      try { video.currentTime = t; } catch {}
    }
    if (s.playing && video.paused) {
      video.play().then(() => $('unmute').classList.add('hidden'))
        .catch(() => $('unmute').classList.remove('hidden'));  // 浏览器自动播放限制
    } else if (!s.playing && !video.paused) {
      video.pause();
    }
  }

  $('unmute').onclick = () => {
    $('unmute').classList.add('hidden');
    if (lastState) applyState(lastState, true);
  };

  // ---------- 本地操作 -> 广播 ----------
  const local = () => Date.now() > suppressUntil;
  function send(type, extra = {}) {
    socket.emit('control', { type, time: video.currentTime, ...extra });
    if (lastState) Object.assign(lastState, {
      playing: type === 'play' ? true : type === 'pause' ? false : lastState.playing,
      time: video.currentTime, rate: video.playbackRate, serverNow: Date.now() + clockOffset,
    });
  }
  video.addEventListener('play', () => local() && send('play'));
  video.addEventListener('pause', () => local() && !video.ended && send('pause'));
  video.addEventListener('seeked', () => local() && send('seek'));
  video.addEventListener('ratechange', () => local() && send('rate', { rate: video.playbackRate }));

  // 定期纠正漂移
  setInterval(() => {
    if (!currentSrc || !local()) return;
    socket.emit('getState', (s) => {
      if (!s) return;
      const drift = Math.abs(video.currentTime - targetTime(s));
      if (drift > 1.5 || s.playing === video.paused || s.src !== currentSrc) applyState(s);
      else lastState = s;
    });
  }, 5000);

  // ---------- 换视频 ----------
  $('setUrl').onclick = () => {
    const url = $('url').value.trim();
    if (!/^https?:\/\//i.test(url)) return alert('请输入以 http:// 或 https:// 开头的视频链接');
    socket.emit('setSource', { src: url, title: decodeURIComponent(url.split('/').pop().split('?')[0]) });
    $('url').value = '';
  };

  $('file').onchange = () => {
    const f = $('file').files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('video', f);
    const xhr = new XMLHttpRequest();
    const bar = $('progress');
    bar.classList.remove('hidden');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.round((e.loaded / e.total) * 100);
      bar.firstElementChild.style.width = p + '%';
      bar.lastElementChild.textContent = `上传中 ${p}% · ${f.name}`;
    };
    xhr.onload = () => {
      bar.classList.add('hidden');
      $('file').value = '';
      let res = {};
      try { res = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status !== 200) return alert('上传失败：' + (res.error || xhr.status));
      socket.emit('setSource', { src: res.url, title: res.name });
    };
    xhr.onerror = () => { bar.classList.add('hidden'); alert('上传失败，网络错误'); };
    xhr.open('POST', '/api/upload');
    xhr.send(fd);
  };

  // ---------- 成员 & 聊天 ----------
  function renderUsers(list) {
    $('users').innerHTML = '';
    list.forEach((n) => { const li = document.createElement('li'); li.textContent = n; $('users').appendChild(li); });
    $('count').textContent = `(${list.length})`;
  }
  function addMsg(m) {
    const div = document.createElement('div');
    if (m.system) { div.className = 'sys'; div.textContent = m.text; }
    else {
      div.className = 'msg';
      const b = document.createElement('b'); b.textContent = m.name;
      div.append(b, document.createTextNode(m.text));
    }
    const box = $('messages');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.appendChild(div);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('chatInput').value.trim();
    if (t) socket.emit('chat', t);
    $('chatInput').value = '';
  };

  $('copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); $('copyLink').textContent = '已复制 ✓'; }
    catch { prompt('复制这个链接发给朋友：', location.href); }
    setTimeout(() => ($('copyLink').textContent = '复制邀请链接'), 1500);
  };

  // ---------- Socket ----------
  socket.on('connect', () => {
    $('status').textContent = '已连接';
    syncClock();
    socket.emit('join', { room: roomId, name }, ({ state, users, me }) => {
      name = me;
      renderUsers(users);
      applyState(state, true);
    });
  });
  socket.on('disconnect', () => ($('status').textContent = '连接断开，正在重连…'));
  socket.on('state', (s) => applyState(s));
  socket.on('users', renderUsers);
  socket.on('chat', addMsg);
  setInterval(syncClock, 30000);
})();

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

  // ---------- 播放错误提示 ----------
  let loadTimer = null;
  let errorShown = false;
  let proxied = false;       // 当前视频是否经服务器中转（只影响自己，不影响房间里其他人）
  let canProxyNow = false;
  const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
  const inApp = /MicroMessenger|QQ\/|Weibo|DingTalk/i.test(navigator.userAgent);

  function showError(title, detail, canProxy = false) {
    errorShown = true;
    clearTimeout(loadTimer);
    $('errTitle').textContent = title;
    $('errDetail').textContent = detail || '';
    $('errProxy').classList.toggle('hidden', !canProxy);
    $('errorBox').classList.remove('hidden');
    $('unmute').classList.add('hidden');
  }
  function hideError() {
    errorShown = false;
    $('errorBox').classList.add('hidden');
  }
  function reload(useProxy) {
    hideError();
    const src = currentSrc; currentSrc = '';
    loadSource(src, useProxy);
    if (lastState) applyState(lastState, true);
  }
  $('errRetry').onclick = () => reload(proxied);
  $('errProxy').onclick = () => reload(true);

  const MEDIA_ERR = {
    1: '视频加载被中止',
    2: '网络错误，视频下载中断',
    3: '视频解码失败（文件可能损坏或编码不受支持）',
    4: '浏览器无法播放这个链接',
  };

  // 让服务器去访问一次链接，拿到真实的状态码 / 文件类型，给出具体原因
  async function diagnose(src, mediaCode) {
    const lines = [];
    if (/^\/uploads\//.test(src)) {
      lines.push(mediaCode === 4 || mediaCode === 3
        ? '上传的文件格式或编码浏览器不支持（常见于 MKV、AVI、H.265/HEVC、AC3/DTS 音轨）。\n建议转成 H.264 + AAC 的 MP4 后再上传。'
        : '无法从服务器加载上传的文件，请检查服务器状态或重新上传。');
      return lines.join('\n');
    }
    let p = null;
    try { p = await (await fetch('/api/probe?url=' + encodeURIComponent(src))).json(); } catch {}
    if (!p) return '无法诊断：连接本站服务器失败。';
    const typeOk = /^video\/|mpegurl/i.test(p.contentType);
    const isVideoish = p.ok && !/html|json|text/.test(p.contentType) && !/\.m3u8(\?|$)/i.test(src);
    // 服务器能拿到视频，只是类型不对：Safari / 内置浏览器直接自动切换到服务器中转
    if (isVideoish && !typeOk && (isSafari || inApp) && !proxied) return { autoProxy: true };
    canProxyNow = isVideoish && !proxied;
    if (p.reason) lines.push(p.reason + '。');
    else if (p.status === 401 || /未登录|login|unauthor/i.test(p.body)) lines.push(`链接需要登录才能访问（${p.status}）。\n请换成不需要登录的分享直链，或下载后用「上传本地视频」。`);
    else if (p.status === 403) lines.push('链接拒绝访问（403），可能有防盗链、链接签名已过期或限制了 IP。\n请重新获取链接，或下载后上传。');
    else if (p.status === 404 || p.status === 410) lines.push(`文件不存在或链接已失效（${p.status}）。`);
    else if (p.status >= 400) lines.push(`视频服务器返回错误 ${p.status}。`);
    else if (/html/.test(p.contentType)) lines.push('这个链接打开的是网页，不是视频文件。\nB 站、YouTube、爱奇艺等视频网站的页面地址无法直接播放，需要以 .mp4 / .m3u8 结尾的视频文件直链。');
    else if (/json|text/.test(p.contentType) && !/mpegurl/i.test(p.contentType)) lines.push('链接返回的是文本数据，不是视频文件：' + (p.body || '').slice(0, 80));
    else {
      // 服务器能正常拿到文件，问题出在浏览器这一侧
      if (proxied) {
        lines.push('已经通过服务器中转仍无法播放，多半是视频编码当前浏览器不支持（常见于 MKV、H.265/HEVC、AC3/DTS 音轨）。\n可以换 Chrome / Edge 再试，或转成 H.264 + AAC 的 MP4。');
      } else if (mediaCode === 3 || mediaCode === 4) {
        if (!typeOk) lines.push(`链接可以访问，但服务器返回的文件类型是「${p.contentType || '未知'}」，浏览器可能无法识别；也可能是视频编码不受支持（MKV、H.265/HEVC、AC3/DTS 音轨等）。`);
        else lines.push('链接可以访问，但视频编码当前浏览器不支持（常见于 MKV、H.265/HEVC、AC3/DTS 音轨）。\n可以换 Chrome / Edge 再试，或转成 H.264 + AAC 的 MP4。');
      } else {
        lines.push(`本站服务器能正常访问这个链接（最终地址：${p.finalHost}），但你的浏览器加载失败。\n可能是你的网络连不上该视频服务器（例如开着代理、在海外访问国内 CDN），或网速太慢。`);
      }
      if (canProxyNow) lines.push('可以点下方「通过服务器中转播放」试试（视频流量会经过本站服务器）。');
      if (!p.range) lines.push('提示：该服务器不支持断点续传，拖动进度条可能无效。');
    }
    if (location.protocol === 'https:' && /^http:\/\//i.test(src)) lines.push('另外：本站是 https，而视频链接是 http，浏览器会拦截这种混合内容。');
    return lines.join('\n');
  }

  async function handleLoadError(title, mediaCode) {
    if (errorShown || !currentSrc) return;
    const src = currentSrc;
    canProxyNow = false;
    showError(title, '正在分析原因…');
    const detail = await diagnose(src, mediaCode);
    if (src !== currentSrc) return;
    if (detail && detail.autoProxy) {
      $('status').textContent = '已连接 · 当前浏览器不兼容该链接，已改为服务器中转播放';
      return reload(true);
    }
    showError(title, detail, canProxyNow);
  }

  video.addEventListener('error', () => {
    if (!currentSrc || hls) return; // hls 的错误单独处理
    const code = video.error ? video.error.code : 0;
    handleLoadError(MEDIA_ERR[code] || '视频加载失败', code);
  });
  video.addEventListener('loadedmetadata', () => { clearTimeout(loadTimer); hideError(); });

  // ---------- 载入视频 ----------
  function loadSource(src, useProxy = false) {
    if (src === currentSrc) return;
    currentSrc = src;
    proxied = useProxy && /^https?:\/\//i.test(src);
    hideError();
    clearTimeout(loadTimer);
    if (hls) { hls.destroy(); hls = null; }
    $('empty').classList.toggle('hidden', !!src);
    if (!src) { video.removeAttribute('src'); video.load(); return; }
    if (location.protocol === 'https:' && /^http:\/\//i.test(src)) {
      showError('浏览器拦截了这个链接', '本站使用 https，而视频链接是 http，浏览器出于安全原因禁止播放。\n请换成 https 开头的链接，或下载后上传。');
      return;
    }
    loadTimer = setTimeout(() => {
      if (video.readyState < 1) handleLoadError('视频加载超时', 0);
    }, 20000);
    if (/\.m3u8(\?|$)/i.test(src) && !video.canPlayType('application/vnd.apple.mpegurl') && window.Hls && Hls.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const cors = d.response && d.response.code === 0;
          if (cors) showError('m3u8 加载失败', '视频服务器不允许其他网站跨域读取（CORS），浏览器无法播放这个 m3u8。\n请换其他来源，或下载后上传。');
          else handleLoadError(`m3u8 加载失败（${d.details}）`, 2);
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          showError('m3u8 视频解码失败', '视频编码当前浏览器不支持，或流已损坏。(' + d.details + ')');
        } else {
          showError('m3u8 播放失败', d.details);
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = proxied ? '/api/stream?url=' + encodeURIComponent(src) : src;
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
    if (/(bilibili\.com|b23\.tv|youtube\.com|youtu\.be|iqiyi\.com|v\.qq\.com|youku\.com|mgtv\.com|douyin\.com|ixigua\.com)/i.test(url) &&
        !confirm('这看起来是视频网站的网页地址，不是视频文件直链，通常无法播放。\n仍然要试试吗？')) return;
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

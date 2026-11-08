(() => {
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const roomId = decodeURIComponent(location.pathname.split('/').pop());
  $('roomLabel').textContent = roomId;

  const store = {
    get(k, s = localStorage) { try { return s.getItem(k) || ''; } catch { return ''; } },
    set(k, v, s = localStorage) { try { s.setItem(k, v); } catch {} },
    del(k, s = localStorage) { try { s.removeItem(k); } catch {} },
  };

  let name = store.get('wt_name');
  if (!name) {
    name = (prompt('请输入你的昵称') || '').trim();
    store.set('wt_name', name);
  }
  // 持久身份：刷新/断线重连后仍然是房主或管理员
  let uid = store.get('wt_uid');
  if (!uid) { uid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''); store.set('wt_uid', uid); }
  const passKey = 'wt_pass_' + roomId;
  const createKey = 'wt_create_' + roomId;

  const socket = io();
  let clockOffset = 0;          // 服务器时间 - 本地时间
  let currentSrc = '';
  let engine = null;            // hls.js / mpegts / dash.js 实例
  let suppressUntil = 0;        // 应用远端状态期间屏蔽本地事件回传
  let lastState = null;
  let info = { playlist: [], history: [], controlMode: 'all', mode: 'order' };
  let users = [];
  let mySid = '';
  let freeMode = false;
  let joined = false;

  const myRole = () => (users.find((u) => u.sid === mySid) || {}).role || 'member';
  const canControl = () => info.controlMode === 'all' || myRole() !== 'member';
  const canManage = () => myRole() !== 'member';

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
  const isM3u8 = (s) => /\.m3u8(\?|$)/i.test(s);
  const isFlv = (s) => /\.flv(\?|$)/i.test(s);
  const isMpd = (s) => /\.mpd(\?|$)/i.test(s);

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
    try { p = await (await fetch(`/api/probe?room=${encodeURIComponent(roomId)}&url=${encodeURIComponent(src)}`)).json(); } catch {}
    if (!p) return '无法诊断：连接本站服务器失败。';
    const typeOk = /^video\/|mpegurl|dash/i.test(p.contentType);
    const isVideoish = p.ok && !/html|json|text/.test(p.contentType) && !isM3u8(src) && !isMpd(src);
    // 服务器能拿到视频，只是类型不对：Safari / 内置浏览器直接自动切换到服务器中转
    if (isVideoish && !typeOk && (isSafari || inApp) && !proxied) return { autoProxy: true };
    canProxyNow = (isVideoish || (p.ok && isM3u8(src))) && !proxied;
    if (p.reason) lines.push(p.reason + '。');
    else if (p.status === 401 || /未登录|login|unauthor/i.test(p.body)) lines.push(`链接需要登录才能访问（${p.status}）。\n可以在「防盗链 / 自定义请求头」里填 Cookie，或下载后用「上传本地视频」。`);
    else if (p.status === 403) lines.push('链接拒绝访问（403），可能有防盗链、链接签名已过期或限制了 IP。\n如果是防盗链，可以在「防盗链 / 自定义请求头」里填 Referer 后重新添加；否则请重新获取链接，或下载后上传。');
    else if (p.status === 404 || p.status === 410) lines.push(`文件不存在或链接已失效（${p.status}）。`);
    else if (p.status >= 400) lines.push(`视频服务器返回错误 ${p.status}。`);
    else if (/html/.test(p.contentType)) lines.push('这个链接打开的是网页，不是视频文件。\nB 站、YouTube、爱奇艺等视频网站的页面地址无法直接播放，需要以 .mp4 / .m3u8 / .flv 结尾的视频文件直链。');
    else if (/json|text/.test(p.contentType) && !/mpegurl/i.test(p.contentType)) lines.push('链接返回的是文本数据，不是视频文件：' + (p.body || '').slice(0, 80));
    else {
      // 服务器能正常拿到文件，问题出在浏览器这一侧
      if (proxied) {
        lines.push('已经通过服务器中转仍无法播放，多半是视频编码当前浏览器不支持（常见于 MKV、H.265/HEVC、AC3/DTS 音轨）。\n可以换 Chrome / Edge 再试，或转成 H.264 + AAC 的 MP4。');
      } else if (mediaCode === 3 || mediaCode === 4) {
        if (!typeOk) lines.push(`链接可以访问，但服务器返回的文件类型是「${p.contentType || '未知'}」，浏览器可能无法识别；也可能是视频编码不受支持（MKV、H.265/HEVC、AC3/DTS 音轨等）。`);
        else lines.push('链接可以访问，但视频编码当前浏览器不支持（常见于 MKV、H.265/HEVC、AC3/DTS 音轨）。\n可以换 Chrome / Edge 再试，或转成 H.264 + AAC 的 MP4。');
      } else {
        lines.push(`本站服务器能正常访问这个链接（最终地址：${p.finalHost}），但你的浏览器加载失败。\n可能是你的网络连不上该视频服务器（例如开着代理、在海外访问国内 CDN）、视频服务器不允许跨域，或网速太慢。`);
      }
      if (canProxyNow) lines.push('可以点下方「通过服务器中转播放」试试（视频流量会经过本站服务器）。');
      if (!p.range && !isM3u8(src)) lines.push('提示：该服务器不支持断点续传，拖动进度条可能无效。');
    }
    if (location.protocol === 'https:' && /^http:\/\//i.test(src) && !proxied) lines.push('另外：本站是 https，而视频链接是 http，浏览器会拦截这种混合内容。');
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
    if (!currentSrc || engine) return; // hls / flv / dash 的错误单独处理
    const code = video.error ? video.error.code : 0;
    handleLoadError(MEDIA_ERR[code] || '视频加载失败', code);
  });
  video.addEventListener('loadedmetadata', () => { clearTimeout(loadTimer); hideError(); });

  // ---------- 载入视频（直链 / HLS / FLV / DASH） ----------
  const scripts = {};
  function loadScript(url) {
    return scripts[url] || (scripts[url] = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = url; s.onload = ok; s.onerror = () => { delete scripts[url]; fail(new Error('加载播放组件失败')); };
      document.head.appendChild(s);
    }));
  }
  function destroyEngine() {
    if (!engine) return;
    try { engine.kind === 'hls' ? engine.p.destroy() : engine.kind === 'flv' ? engine.p.destroy() : engine.p.reset(); } catch {}
    engine = null;
    $('quality').classList.add('hidden');
  }
  const proxyUrl = (src) => `/api/stream?room=${encodeURIComponent(roomId)}&url=${encodeURIComponent(src)}`;

  function loadSource(src, useProxy = false) {
    if (src === currentSrc) return;
    currentSrc = src;
    proxied = useProxy && /^https?:\/\//i.test(src);
    hideError();
    clearTimeout(loadTimer);
    destroyEngine();
    setSubtitle(null);
    $('empty').classList.toggle('hidden', !!src);
    if (!src) { video.removeAttribute('src'); video.load(); return; }
    if (location.protocol === 'https:' && /^http:\/\//i.test(src) && !proxied) {
      showError('浏览器拦截了这个链接', '本站使用 https，而视频链接是 http，浏览器出于安全原因禁止直接播放。', true);
      return;
    }
    loadTimer = setTimeout(() => {
      if (video.readyState < 1) handleLoadError('视频加载超时', 0);
    }, 20000);
    const url = proxied ? proxyUrl(src) : src;

    if (isFlv(src)) return loadFlv(src, url);
    if (isMpd(src)) return loadDash(src, url);
    if (isM3u8(src) && !video.canPlayType('application/vnd.apple.mpegurl') && window.Hls && Hls.isSupported()) {
      const hls = new Hls();
      engine = { kind: 'hls', p: hls };
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const levels = hls.levels || [];
        const sel = $('quality');
        sel.innerHTML = '';
        if (levels.length < 2) return sel.classList.add('hidden');
        sel.add(new Option('画质：自动', '-1'));
        levels.forEach((l, i) => sel.add(new Option(l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)}kbps`, String(i))));
        sel.classList.remove('hidden');
      });
      hls.on(Hls.Events.ERROR, (e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const cors = d.response && d.response.code === 0;
          if (cors && !proxied) showError('m3u8 加载失败', '视频服务器不允许其他网站跨域读取（CORS），浏览器无法直接播放这个 m3u8。\n可以点下方「通过服务器中转播放」（视频流量会经过本站服务器）。', true);
          else handleLoadError(`m3u8 加载失败（${d.details}）`, 2);
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          showError('m3u8 视频解码失败', '视频编码当前浏览器不支持，或流已损坏。(' + d.details + ')');
        } else {
          showError('m3u8 播放失败', d.details);
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
    }
  }
  async function loadFlv(src, url) {
    try { await loadScript('/vendor/mpegts.js'); } catch (e) { return showError('FLV 播放组件加载失败', e.message); }
    if (src !== currentSrc) return;
    if (!window.mpegts || !mpegts.isSupported()) return showError('当前浏览器不支持播放 FLV', 'iPhone / iPad 上的浏览器不支持 FLV，请换电脑或安卓设备。');
    const p = mpegts.createPlayer({ type: 'flv', url }, { enableStashBuffer: false });
    engine = { kind: 'flv', p };
    p.on(mpegts.Events.ERROR, (type, detail) => {
      if (type === mpegts.ErrorTypes.NETWORK_ERROR) handleLoadError(`FLV 加载失败（${detail}）`, 2);
      else showError('FLV 播放失败', String(detail));
    });
    p.attachMediaElement(video);
    p.load();
    if (lastState) applyState(lastState, true);
  }
  async function loadDash(src, url) {
    try { await loadScript('/vendor/dash.js'); } catch (e) { return showError('DASH 播放组件加载失败', e.message); }
    if (src !== currentSrc) return;
    const p = dashjs.MediaPlayer().create();
    engine = { kind: 'dash', p };
    p.on('error', (e) => {
      const err = e.error || {};
      if (/download|manifest/i.test(String(err.message || err))) handleLoadError('DASH 加载失败', 2);
      else showError('DASH 播放失败', String(err.message || err.code || ''));
    });
    p.initialize(video, url, false);
    if (lastState) applyState(lastState, true);
  }
  $('quality').onchange = () => { if (engine && engine.kind === 'hls') engine.p.currentLevel = Number($('quality').value); };

  // ---------- 字幕 ----------
  let subUrl = '';
  let subOn = true;
  function setSubtitle(sub) {
    const url = sub ? sub.url : '';
    $('subToggle').classList.toggle('hidden', !url);
    if (url === subUrl) return;
    subUrl = url;
    video.querySelectorAll('track').forEach((t) => t.remove());
    if (!url) return;
    const t = document.createElement('track');
    Object.assign(t, { kind: 'subtitles', label: sub.label || '字幕', srclang: 'zh', src: url, default: true });
    video.appendChild(t);
    t.track.mode = subOn ? 'showing' : 'hidden';
  }
  $('subToggle').onclick = () => {
    subOn = !subOn;
    $('subToggle').textContent = subOn ? '字幕：开' : '字幕：关';
    $('subToggle').classList.toggle('on', subOn);
    video.querySelectorAll('track').forEach((t) => (t.track.mode = subOn ? 'showing' : 'hidden'));
  };
  $('subFile').onchange = () => {
    const f = $('subFile').files[0];
    $('subFile').value = '';
    if (!f) return;
    if (!currentSrc) return alert('请先播放一个视频，再上传字幕');
    const fd = new FormData(); fd.append('subtitle', f);
    fetch('/api/subtitle', { method: 'POST', body: fd })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) return alert('字幕上传失败：' + res.error);
        socket.emit('subtitle', { url: res.url, label: res.name });
      })
      .catch(() => alert('字幕上传失败，网络错误'));
  };

  function targetTime(s) {
    if (!s.playing) return s.time;
    const elapsed = (Date.now() + clockOffset - s.serverNow) / 1000;
    return s.time + Math.max(0, elapsed) * s.rate;
  }

  // ---------- 应用远端状态 ----------
  function applyState(s, force = false) {
    const changed = !lastState || s.src !== lastState.src || s.itemId !== lastState.itemId;
    lastState = s;
    $('title').textContent = s.title || '';
    if (s.src !== currentSrc || changed) {
      currentSrc = changed ? '' : currentSrc;
      loadSource(s.src, s.proxy || (proxied && s.src === currentSrc));
    }
    setSubtitle(s.subtitle);
    if (!s.src) return;
    // 只有真正改动了播放器时才屏蔽本地事件，避免吞掉用户紧接着的操作
    const mute = () => (suppressUntil = Date.now() + 800);
    if (changed) mute();
    if (freeMode && !force && !changed) return;
    if (video.playbackRate !== s.rate) { mute(); video.playbackRate = s.rate; }
    const live = video.duration === Infinity;
    const t = targetTime(s);
    const atEnd = Number.isFinite(video.duration) && video.duration > 0 && t >= video.duration - 0.5;
    if (!live && (force || Math.abs(video.currentTime - t) > 1) && !(atEnd && video.ended)) {
      mute();
      try { video.currentTime = t; } catch {}
    }
    if (s.playing && video.paused && !atEnd) {
      mute();
      video.play().then(() => $('unmute').classList.add('hidden'))
        .catch(() => $('unmute').classList.remove('hidden'));  // 浏览器自动播放限制
    } else if (!s.playing && !video.paused) {
      mute();
      video.pause();
    }
  }

  $('unmute').onclick = () => {
    $('unmute').classList.add('hidden');
    if (lastState) applyState(lastState, true);
  };

  // ---------- 本地操作 -> 广播 ----------
  const local = () => Date.now() > suppressUntil && !freeMode;
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
  video.addEventListener('ended', () => {
    if (!freeMode && lastState && lastState.itemId) socket.emit('ended', { itemId: lastState.itemId });
  });

  // 定期纠正漂移
  setInterval(() => {
    if (!currentSrc || !local()) return;
    socket.emit('getState', (s) => {
      if (!s || !local()) return;
      const drift = Math.abs(video.currentTime - targetTime(s));
      const live = video.duration === Infinity;
      if ((drift > 1.5 && !live && !video.ended) || (s.playing === video.paused && !video.ended) || s.src !== currentSrc || s.itemId !== lastState?.itemId) applyState(s);
      else lastState = s;
    });
  }, 5000);

  // ---------- 自由模式 ----------
  $('freeMode').onchange = () => {
    freeMode = $('freeMode').checked;
    $('resync').classList.toggle('hidden', !freeMode);
    if (!freeMode) $('resync').click();
  };
  $('resync').onclick = () => socket.emit('getState', (s) => s && applyState(s, true));

  // ---------- 换视频 / 播放列表 ----------
  function parseHeaders() {
    const out = {};
    for (const line of $('headers').value.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return Object.keys(out).length ? out : null;
  }
  function addUrl(play) {
    const url = $('url').value.trim();
    if (!/^https?:\/\//i.test(url)) return alert('请输入以 http:// 或 https:// 开头的视频链接');
    if (/(bilibili\.com|b23\.tv|youtube\.com|youtu\.be|iqiyi\.com|v\.qq\.com|youku\.com|mgtv\.com|douyin\.com|ixigua\.com)/i.test(url) &&
        !confirm('这看起来是视频网站的网页地址，不是视频文件直链，通常无法播放。\n仍然要试试吗？')) return;
    socket.emit('pl:add', { src: url, headers: parseHeaders(), play });
    $('url').value = '';
  }
  $('setUrl').onclick = () => addUrl(true);
  $('addUrl').onclick = () => addUrl(false);
  $('url').onkeydown = (e) => e.key === 'Enter' && addUrl(true);
  $('nextBtn').onclick = () => socket.emit('pl:next');
  $('mode').onchange = () => socket.emit('pl:mode', $('mode').value);
  $('plClear').onclick = () => confirm('清空播放列表？（正在播放的会保留）') && socket.emit('pl:clear');

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
      socket.emit('pl:add', { src: res.url, title: res.name, play: true });
    };
    xhr.onerror = () => { bar.classList.add('hidden'); alert('上传失败，网络错误'); };
    xhr.open('POST', '/api/upload');
    xhr.send(fd);
  };

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
    e.append(...kids.filter((k) => k != null));
    return e;
  }
  function renderPlaylist() {
    const cur = lastState && lastState.itemId;
    const ctl = canControl();
    $('playlist').innerHTML = '';
    if (!info.playlist.length) $('playlist').append(el('li', { class: 'muted small empty' }, '列表是空的，粘贴链接后点「加入列表」'));
    info.playlist.forEach((it, i) => {
      const tags = (it.hasHeaders ? ' 🔗' : '') + (it.hasSubtitle ? ' 💬' : '');
      $('playlist').append(el('li', { class: it.id === cur ? 'current' : '' },
        el('span', { class: 'idx' }, it.id === cur ? '▶' : String(i + 1)),
        el('span', { class: 'name', title: it.src }, it.title + tags),
        ctl ? el('span', { class: 'ops' },
          el('button', { title: '播放', onclick: () => socket.emit('pl:play', { id: it.id }) }, '▶'),
          el('button', { title: '上移', onclick: () => socket.emit('pl:move', { id: it.id, dir: -1 }) }, '↑'),
          el('button', { title: '下移', onclick: () => socket.emit('pl:move', { id: it.id, dir: 1 }) }, '↓'),
          el('button', { title: '删除', onclick: () => socket.emit('pl:remove', { id: it.id }) }, '✕')) : null));
    });
    $('history').innerHTML = '';
    if (!info.history.length) $('history').append(el('li', { class: 'muted small empty' }, '还没有播放过视频'));
    info.history.forEach((it) => {
      $('history').append(el('li', {},
        el('span', { class: 'name', title: it.src }, it.title),
        ctl ? el('span', { class: 'ops' }, el('button', { title: '再看一次', onclick: () => socket.emit('pl:play', { id: it.id }) }, '↺')) : null));
    });
    $('plCount').textContent = info.playlist.length ? `(${info.playlist.length})` : '';
  }
  function renderInfo() {
    $('mode').value = info.mode;
    $('lockIcon').classList.toggle('hidden', !info.hasPassword);
    $('roomLabel').textContent = info.name ? `${info.name}（${roomId}）` : roomId;
    document.title = (info.name || '房间 ' + roomId) + ' - MM0 一起看';
    const editing = $('settingsForm').contains(document.activeElement);
    if (!editing) {
      $('setName').value = info.name || '';
      $('setPublic').checked = !!info.public;
      $('setControl').value = info.controlMode;
      $('setPass').value = ''; $('clearPass').checked = false;
    }
    $('passState').textContent = info.hasPassword ? '（已设置）' : '（未设置）';
    renderPermissions();
    renderPlaylist();
  }
  function renderPermissions() {
    const ctl = canControl(), mgr = canManage();
    document.querySelectorAll('.ctl').forEach((b) => { b.disabled = !ctl; b.classList.toggle('disabled', !ctl); });
    document.querySelectorAll('.ctl-area').forEach((a) => a.classList.toggle('hidden', !ctl));
    $('settingsForm').querySelectorAll('input,select,button').forEach((x) => (x.disabled = !mgr));
    $('settingsNote').textContent = mgr ? '' : '只有房主和管理员可以修改房间设置。';
    if (!ctl) $('status').textContent = '已连接 · 房主设置了仅房主和管理员可以控制播放';
  }

  // ---------- 成员 ----------
  const ROLE_TEXT = { owner: '房主', admin: '管理员' };
  function renderUsers(list) {
    users = list;
    const me = myRole();
    $('users').innerHTML = '';
    list.forEach((u) => {
      const ops = [];
      if (u.sid !== mySid) {
        if (me === 'owner') {
          ops.push(el('button', { onclick: () => socket.emit('setAdmin', { sid: u.sid, admin: u.role !== 'admin' }) }, u.role === 'admin' ? '取消管理员' : '设为管理员'));
          ops.push(el('button', { onclick: () => confirm(`确定把房主转让给 ${u.name}？`) && socket.emit('transfer', { sid: u.sid }) }, '转让房主'));
        }
        if ((me === 'owner' && u.role !== 'owner') || (me === 'admin' && u.role === 'member')) {
          ops.push(el('button', { class: 'danger', onclick: () => confirm(`确定踢出 ${u.name}？（5 分钟内不能重新加入）`) && socket.emit('kick', { sid: u.sid }) }, '踢出'));
        }
      }
      $('users').append(el('li', {},
        el('span', { class: 'name' }, u.name + (u.sid === mySid ? '（我）' : '')),
        u.voice ? el('span', { title: '在语音中' }, '🎙') : null,
        ROLE_TEXT[u.role] ? el('span', { class: 'badge ' + u.role }, ROLE_TEXT[u.role]) : null,
        ops.length ? el('span', { class: 'ops' }, ...ops) : null));
    });
    $('count').textContent = `(${list.length})`;
    renderPermissions();
    renderPlaylist();
  }

  // ---------- 房间设置 ----------
  $('settingsForm').onsubmit = (e) => {
    e.preventDefault();
    const s = { name: $('setName').value, public: $('setPublic').checked, controlMode: $('setControl').value };
    if ($('clearPass').checked) s.password = '';
    else if ($('setPass').value) s.password = $('setPass').value;
    if (typeof s.password === 'string') store.set(passKey, s.password, sessionStorage);
    socket.emit('settings', s);
    document.activeElement.blur();
    $('settingsNote').textContent = '已保存 ✓';
  };

  // ---------- 标签页 ----------
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + b.dataset.tab));
  }));

  // ---------- 聊天 & 弹幕 ----------
  let danmakuOn = store.get('wt_danmaku') !== 'off';
  function renderDanmakuBtn() {
    $('danmakuToggle').textContent = danmakuOn ? '弹幕：开' : '弹幕：关';
    $('danmakuToggle').classList.toggle('on', danmakuOn);
    $('danmaku').classList.toggle('hidden', !danmakuOn);
  }
  renderDanmakuBtn();
  $('danmakuToggle').onclick = () => { danmakuOn = !danmakuOn; store.set('wt_danmaku', danmakuOn ? 'on' : 'off'); renderDanmakuBtn(); };

  const lanes = [];   // 每条轨道最近一条弹幕完全进入画面的时间
  function shootDanmaku(text, mine) {
    if (!danmakuOn || document.hidden) return;
    const layer = $('danmaku');
    const W = layer.clientWidth, H = layer.clientHeight;
    if (!W || !H) return;
    const lineH = 32, count = Math.max(1, Math.floor((H * 0.75) / lineH));
    const now = Date.now();
    let lane = 0;
    for (let i = 0; i < count; i++) { if (!lanes[i] || lanes[i] <= now) { lane = i; break; } lane = (lanes[lane] || 0) <= (lanes[i] || 0) ? lane : i; }
    const d = el('div', { class: 'dm' + (mine ? ' mine' : '') }, text.slice(0, 60));
    d.style.top = lane * lineH + 8 + 'px';
    d.style.transform = `translateX(${W}px)`;
    layer.appendChild(d);
    const w = d.offsetWidth, duration = 8000, speed = (W + w) / duration;
    lanes[lane] = now + (w + 24) / speed;
    const a = d.animate([{ transform: `translateX(${W}px)` }, { transform: `translateX(${-w}px)` }], { duration, easing: 'linear' });
    a.onfinish = () => d.remove();
  }

  function addMsg(m, live = true) {
    const div = document.createElement('div');
    const time = m.t ? new Date(m.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    if (m.system) { div.className = 'sys'; div.textContent = (time ? time + ' ' : '') + m.text; }
    else {
      div.className = 'msg';
      const b = document.createElement('b'); b.textContent = m.name;
      div.append(b, document.createTextNode(m.text));
      if (time) div.title = time;
      if (live) shootDanmaku(m.text, m.sid === mySid);
    }
    const box = $('messages');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.appendChild(div);
    if (atBottom || !live) box.scrollTop = box.scrollHeight;
  }
  function sendChat(input) {
    const t = input.value.trim();
    if (t) socket.emit('chat', t);
    input.value = '';
  }
  $('chatForm').onsubmit = (e) => { e.preventDefault(); sendChat($('chatInput')); };
  $('fsChat').onsubmit = (e) => { e.preventDefault(); sendChat($('fsChatInput')); };

  // ---------- 全屏（整个播放区域全屏，弹幕才能一起显示） / 画中画 ----------
  const wrap = $('wrap');
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  function toggleFs() {
    if (fsEl()) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (req) req.call(wrap);
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone 只支持视频本身全屏
  }
  $('fsBtn').onclick = toggleFs;
  video.addEventListener('dblclick', (e) => { e.preventDefault(); toggleFs(); });
  if (document.pictureInPictureEnabled) {
    $('pipBtn').classList.remove('hidden');
    $('pipBtn').onclick = () => (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch((e) => alert('画中画打开失败：' + e.message));
  }

  $('copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); $('copyLink').textContent = '已复制 ✓'; }
    catch { prompt('复制这个链接发给朋友：', location.href); }
    setTimeout(() => ($('copyLink').textContent = '复制邀请链接'), 1500);
  };

  // ---------- 语音聊天（WebRTC） ----------
  let voice = null; // { stream, peers: Map<sid, pc>, muted }
  let iceServers = null;
  async function joinVoice() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      return alert('浏览器只允许在 https 网站上使用麦克风。\n请给本站配置 https（例如用 Nginx / Caddy 反向代理并申请证书）后再使用语音。');
    }
    $('voiceBtn').disabled = true;
    try {
      if (!iceServers) iceServers = (await (await fetch('/api/config')).json()).iceServers;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      voice = { stream, peers: new Map(), muted: false };
      socket.emit('voice:join', (res) => {
        if (res.error) { alert(res.error); return leaveVoice(true); }
        res.peers.forEach((sid) => peer(sid, true));
        renderVoice();
      });
    } catch (e) {
      alert('加入语音失败：' + (e.name === 'NotAllowedError' ? '没有麦克风权限' : e.message));
      voice = null;
    } finally {
      $('voiceBtn').disabled = false;
    }
    renderVoice();
  }
  function leaveVoice(silent) {
    if (!voice) return;
    voice.peers.forEach((pc, sid) => closePeer(sid));
    voice.stream.getTracks().forEach((t) => t.stop());
    voice = null;
    if (!silent) socket.emit('voice:leave');
    renderVoice();
  }
  function closePeer(sid) {
    const pc = voice && voice.peers.get(sid);
    if (!pc) return;
    pc.close();
    voice.peers.delete(sid);
    const a = document.getElementById('va-' + sid); if (a) a.remove();
  }
  function peer(sid, initiator) {
    const pc = new RTCPeerConnection({ iceServers });
    pc.chain = Promise.resolve();
    voice.peers.set(sid, pc);
    voice.stream.getTracks().forEach((t) => pc.addTrack(t, voice.stream));
    pc.onicecandidate = (e) => e.candidate && socket.emit('voice:signal', { to: sid, data: { candidate: e.candidate } });
    pc.ontrack = (e) => {
      let a = document.getElementById('va-' + sid);
      if (!a) { a = el('audio', { id: 'va-' + sid, autoplay: '' }); $('voiceAudio').append(a); }
      a.srcObject = e.streams[0];
      a.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') $('status').textContent = '语音连接失败：可能双方网络都在 NAT 后面，需要在 ICE_SERVERS 配置 TURN 服务器'; };
    if (initiator) {
      pc.chain = pc.chain.then(async () => {
        await pc.setLocalDescription(await pc.createOffer());
        socket.emit('voice:signal', { to: sid, data: { sdp: pc.localDescription } });
      });
    }
    return pc;
  }
  socket.on('voice:signal', ({ from, data }) => {
    if (!voice) return;
    const pc = voice.peers.get(from) || peer(from, false);
    pc.chain = pc.chain.then(async () => {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          socket.emit('voice:signal', { to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      }
    }).catch((e) => console.warn('voice', e));
  });
  socket.on('voice:left', (sid) => closePeer(sid));
  function renderVoice() {
    $('voiceBtn').textContent = voice ? '退出语音' : '🎙 加入语音';
    $('voiceBtn').classList.toggle('on', !!voice);
    $('muteBtn').classList.toggle('hidden', !voice);
    if (voice) $('muteBtn').textContent = voice.muted ? '🔇 已静音' : '🎙 静音';
  }
  $('voiceBtn').onclick = () => (voice ? leaveVoice() : joinVoice());
  $('muteBtn').onclick = () => {
    if (!voice) return;
    voice.muted = !voice.muted;
    voice.stream.getAudioTracks().forEach((t) => (t.enabled = !voice.muted));
    renderVoice();
  };

  // ---------- 进入房间（密码 / 被踢） ----------
  function showGate(title, detail, askPass) {
    $('gateTitle').textContent = title;
    $('gateDetail').textContent = detail || '';
    $('gateForm').classList.toggle('hidden', !askPass);
    $('gate').classList.remove('hidden');
    if (askPass) setTimeout(() => $('gatePass').focus(), 50);
  }
  $('gateForm').onsubmit = (e) => {
    e.preventDefault();
    store.set(passKey, $('gatePass').value, sessionStorage);
    $('gatePass').value = '';
    join();
  };
  function join() {
    let create = null;
    try { create = JSON.parse(store.get(createKey, sessionStorage) || 'null'); } catch {}
    socket.emit('join', { room: roomId, name, uid, password: store.get(passKey, sessionStorage), create }, (res) => {
      if (res.error === 'password' || res.error === 'wrongPassword') {
        $('status').textContent = '需要密码';
        return showGate(`${res.name || '这个房间'}设置了密码`, res.error === 'wrongPassword' ? '密码错误，请重新输入' : '请输入房间密码', true);
      }
      if (res.error === 'kicked') return showGate('你被移出了这个房间', `${res.wait} 分钟后才能重新加入`);
      if (res.error) return showGate('无法进入房间', res.error);
      joined = true;
      store.del(createKey, sessionStorage);
      $('gate').classList.add('hidden');
      $('status').textContent = '已连接';
      name = res.me; mySid = res.sid;
      info = res.info;
      $('messages').innerHTML = '';
      res.messages.forEach((m) => addMsg(m, false));
      renderUsers(res.users);
      renderInfo();
      applyState(res.state, true);
    });
  }

  // ---------- Socket ----------
  socket.on('connect', () => {
    $('status').textContent = '已连接';
    syncClock();
    join();
  });
  socket.on('disconnect', (reason) => {
    joined = false;
    leaveVoice(true);
    if (reason !== 'io server disconnect') $('status').textContent = '连接断开，正在重连…';
  });
  socket.on('kicked', (text) => { showGate('你被移出了这个房间', text); $('status').textContent = '已被移出'; destroyEngine(); video.pause(); });
  socket.on('state', (s) => { applyState(s); renderPlaylist(); });
  socket.on('room', (i) => { info = i; renderInfo(); });
  socket.on('users', renderUsers);
  socket.on('chat', (m) => addMsg(m));
  let noticeTimer = null;
  socket.on('notice', (text) => {
    $('status').textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (!joined) return;
      $('status').textContent = '已连接';
      renderPermissions();
    }, 4000);
  });
  setInterval(syncClock, 30000);
})();

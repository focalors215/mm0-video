"""MM0 一起看 - 视频链接解析服务

把 B 站 / YouTube / 抖音等网页地址解析成浏览器能播放的媒体地址，供主服务调用。
只在 docker 内部网络监听，不对外暴露。

GET /resolve?url=<网页地址>  ->  JSON
  kind = file       单个文件（mp4 / webm / flv），字段 url, ext
         hls        单个 m3u8（音视频合一），字段 url
         hls-split  视频 m3u8 + 音频 m3u8（YouTube），字段 video[], audio
         dash       视频 + 音频分轨的 mp4，带 SegmentBase（B 站高画质），字段 video[], audio[]
  其他字段：title, duration, is_live, extractor, headers（访问媒体需要的请求头）,
           direct（浏览器能否直接访问，不经服务器中转）, expires_at（unix 秒）
出错时返回 422 {"error": "中文原因"}
"""
import http.cookiejar
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yt_dlp

PORT = int(os.environ.get('PORT', '8000'))
COOKIES = os.environ.get('COOKIES_FILE', '/cookies/cookies.txt')
MAX_HEIGHT = int(os.environ.get('MAX_HEIGHT', '1080'))
RESTART_HOURS = float(os.environ.get('RESTART_HOURS', '24'))  # 定期退出，由 docker 重启并更新 yt-dlp
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
HEADER_KEYS = ('user-agent', 'referer', 'origin')


class ResolveError(Exception):
    pass


class NotHandled(Exception):
    """专用解析器处理不了，交给 yt-dlp"""


# ---------------- 工具 ----------------
def load_cookies():
    if not os.path.isfile(COOKIES):
        return None
    jar = http.cookiejar.MozillaCookieJar(COOKIES)
    try:
        jar.load(ignore_discard=True, ignore_expires=True)
    except Exception as e:  # 格式不对时忽略，不影响无 cookie 的解析
        print('cookies.txt 读取失败：', e, file=sys.stderr)
        return None
    return jar


def cookie_header(domain):
    jar = load_cookies()
    if not jar:
        return ''
    return '; '.join(f'{c.name}={c.value}' for c in jar if c.domain.lstrip('.').endswith(domain))


def http_get(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.geturl(), r.read()


def expires_from(url, default_seconds=1800):
    u = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qs(u.query)
    m = re.search(r'/expire/(\d+)', u.path)  # YouTube 的 m3u8 把过期时间放在路径里
    vals = [(q.get(k) or [''])[0] for k in ('deadline', 'expire', 'expires', 'x-expires')] + [m.group(1) if m else '']
    for v in vals:
        if v.isdigit() and int(v) > time.time():
            return int(v)
    return int(time.time()) + default_seconds


# ---------------- B 站：直接调用公开接口 ----------------
BILI_QN_HEIGHT = {6: 240, 16: 360, 32: 480, 64: 720, 74: 720, 80: 1080, 112: 1080, 116: 1080, 120: 2160, 125: 2160, 126: 2160, 127: 4320}


def bili_api(path, params, cookie):
    headers = {'Referer': 'https://www.bilibili.com/'}
    if cookie:
        headers['Cookie'] = cookie
    _, body = http_get('https://api.bilibili.com' + path + '?' + urllib.parse.urlencode(params), headers)
    data = json.loads(body)
    if data.get('code') != 0:
        raise ResolveError('B 站返回：' + str(data.get('message') or data.get('code')))
    return data['data']


def bili_pick(main, backups):
    # B 站常把主地址分配到 PCDN 节点（*.mcdn.bilivideo.cn:8082 等），很多网络连不上，优先用普通 CDN 的备用地址
    urls = [u for u in [main, *(backups or [])] if u]
    good = [u for u in urls if not re.search(r'mcdn\.bilivideo|szbdyd\.com|:\d{4,5}/', u)]
    return (good or urls)[0]


def resolve_bilibili(url):
    host = urllib.parse.urlparse(url).hostname or ''
    if host.endswith('b23.tv') or host.endswith('bili2233.cn'):
        url, _ = http_get(url)  # 短链接跳转到真实地址
    u = urllib.parse.urlparse(url)
    m = re.search(r'/video/(?:(BV[0-9A-Za-z]{10})|av(\d+))', u.path, re.I)
    if not m:
        raise NotHandled()  # 番剧、直播等交给 yt-dlp
    ident = {'bvid': m.group(1)} if m.group(1) else {'aid': m.group(2)}
    cookie = cookie_header('bilibili.com')
    view = bili_api('/x/web-interface/view', ident, cookie)
    pages = view.get('pages') or [{'cid': view['cid'], 'page': 1, 'part': '', 'duration': view.get('duration')}]
    try:
        p = int((urllib.parse.parse_qs(u.query).get('p') or ['1'])[0])
    except ValueError:
        p = 1
    page = pages[p - 1] if 1 <= p <= len(pages) else pages[0]
    title = view['title'] + (f' - P{page["page"]} {page["part"]}' if len(pages) > 1 else '')
    params = dict(ident, cid=page['cid'])
    headers = {'referer': 'https://www.bilibili.com/', 'user-agent': UA}
    base = {'title': title, 'duration': page.get('duration') or view.get('duration'), 'is_live': False,
            'extractor': 'bilibili', 'headers': headers}

    # 方案一：html5 mp4（音视频合一，未登录最高 720P，浏览器可以直接访问）
    file_result, file_height = None, 0
    try:
        d = bili_api('/x/player/playurl', dict(params, qn=80, fnval=1, platform='html5', high_quality=1), cookie)
        if d.get('durl'):
            murl = bili_pick(d['durl'][0].get('url'), d['durl'][0].get('backup_url'))
            ext = 'flv' if '.flv' in urllib.parse.urlparse(murl).path else 'mp4'
            file_height = BILI_QN_HEIGHT.get(d.get('quality'), 0)
            file_result = dict(base, kind='file', url=murl, ext=ext, direct=True, height=file_height,
                               expires_at=expires_from(murl, 3600))
    except ResolveError:
        pass

    # 方案二：DASH（登录后可到 1080P 以上），只取浏览器普遍支持的 H.264
    try:
        d = bili_api('/x/player/playurl', dict(params, qn=127, fnval=16, fourk=1), cookie)
        dash = d.get('dash') or {}
        videos = [v for v in dash.get('video') or [] if v.get('codecs', '').startswith('avc') and v.get('height', 0) <= MAX_HEIGHT]
        audios = [a for a in dash.get('audio') or [] if a.get('codecs', '').startswith('mp4a')]
        if videos and audios and (max(v['height'] for v in videos) > file_height or os.environ.get('BILI_FORCE_DASH') == '1'):
            def rep(x):
                sb = x.get('segment_base') or x.get('SegmentBase') or {}
                return {'url': bili_pick(x.get('base_url') or x.get('baseUrl'), x.get('backup_url') or x.get('backupUrl')), 'width': x.get('width'), 'height': x.get('height'),
                        'codecs': x.get('codecs'), 'bandwidth': x.get('bandwidth'), 'frame_rate': x.get('frame_rate') or x.get('frameRate'),
                        'init': sb.get('initialization') or sb.get('Initialization'), 'index': sb.get('index_range') or sb.get('indexRange')}
            v = [rep(x) for x in videos]
            a = [rep(x) for x in audios]
            if all(x['init'] and x['index'] for x in v + a):
                return dict(base, kind='dash', video=v, audio=a, direct=False, height=max(x['height'] for x in v),
                            duration=dash.get('duration') or base['duration'], expires_at=expires_from(v[0]['url'], 3600))
    except ResolveError:
        pass
    if file_result:
        return file_result
    raise ResolveError('B 站没有返回可播放的地址（可能是付费 / 大会员 / 地区限制视频）')


# ---------------- 通用：yt-dlp ----------------
OK_PROTOCOLS = ('http', 'https', 'm3u8', 'm3u8_native')


def has_video(f):
    return f.get('vcodec') != 'none'


def has_audio(f):
    return f.get('acodec') != 'none'


def is_hls(f):
    return f.get('protocol', '').startswith('m3u8')


def codec_ok(f):
    v = f.get('vcodec')
    return v is None or v.startswith(('avc', 'h264'))


def clean_headers(h):
    return {k.lower(): v for k, v in (h or {}).items() if k.lower() in HEADER_KEYS}


def resolve_ytdlp(url):
    opts = {'quiet': True, 'no_warnings': True, 'noplaylist': True, 'skip_download': True,
            'socket_timeout': 15, 'extractor_retries': 1}
    tmp = None
    if os.path.isfile(COOKIES):
        # yt-dlp 结束时会写回 cookie 文件，用临时副本，避免改动只读挂载的原文件
        tmp = tempfile.NamedTemporaryFile(suffix='.txt', delete=False)
        tmp.close()
        shutil.copyfile(COOKIES, tmp.name)
        opts['cookiefile'] = tmp.name
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        raise ResolveError(explain(str(e)))
    finally:
        if tmp:
            os.unlink(tmp.name)
    if info.get('_type') == 'playlist':
        entries = [e for e in info.get('entries') or [] if e]
        if not entries:
            raise ResolveError('这是一个播放列表，里面没有可播放的视频')
        info = entries[0]

    fmts = [f for f in info.get('formats') or [info] if f.get('url') and (f.get('protocol') or 'https') in OK_PROTOCOLS]
    within = lambda f: (f.get('height') or 0) <= MAX_HEIGHT
    base = {'title': info.get('title') or '', 'duration': info.get('duration'), 'is_live': bool(info.get('is_live')),
            'extractor': info.get('extractor_key') or info.get('extractor')}

    # 音视频合一的格式
    muxed = [f for f in fmts if has_video(f) and has_audio(f) and within(f)]
    muxed.sort(key=lambda f: (codec_ok(f), f.get('height') or 0, f.get('tbr') or 0))
    best = muxed[-1] if muxed else None

    # YouTube：视频 m3u8 + 音频 m3u8，拼成一个 HLS 主播放列表，画质更高
    vids = [f for f in fmts if is_hls(f) and has_video(f) and f.get('acodec') == 'none' and within(f)
            and (f.get('vcodec') or '').startswith('avc') and f.get('height')]
    auds = [f for f in fmts if is_hls(f) and f.get('vcodec') == 'none']
    auds.sort(key=lambda f: f.get('tbr') or f.get('abr') or 0)
    # 同画质时也优先 HLS：YouTube 的单文件格式（如 18）经常 403
    if vids and auds and max(f['height'] for f in vids) >= ((best or {}).get('height') or 0):
        by_h = {}
        for f in sorted(vids, key=lambda f: f.get('tbr') or 0):
            by_h[f['height']] = f
        video = [{'url': f['url'], 'width': f.get('width'), 'height': f['height'], 'codecs': f.get('vcodec'),
                  'bandwidth': int((f.get('tbr') or 1000) * 1000)} for f in sorted(by_h.values(), key=lambda f: f['height'])]
        a = auds[-1]
        return dict(base, kind='hls-split', video=video,
                    audio={'url': a['url'], 'codecs': a.get('acodec') if a.get('acodec') not in (None, 'none') else 'mp4a.40.2'},
                    headers=clean_headers(a.get('http_headers')), direct=False, height=video[-1]['height'],
                    expires_at=expires_from(a['url']))
    if not best:
        raise ResolveError('这个网站只提供音视频分开的流，暂时无法播放')
    kind = 'hls' if is_hls(best) else 'file'
    ext = best.get('ext') if best.get('ext') in ('mp4', 'webm', 'flv') else 'mp4'
    return dict(base, kind=kind, url=best['url'], ext=ext, headers=clean_headers(best.get('http_headers')),
                direct=False, height=best.get('height'), expires_at=expires_from(best['url']))


def explain(msg):
    msg = re.sub(r'^ERROR:\s*', '', msg).strip()
    low = msg.lower()
    if 'fresh cookies' in low or ('douyin' in low and 'cookie' in low):
        return '抖音需要 cookies 才能解析：请用浏览器打开 douyin.com 后导出 cookies.txt，放到服务器的 data/cookies/cookies.txt（详见 README）'
    if 'sign in to confirm' in low or 'not a bot' in low:
        return 'YouTube 要求登录验证（服务器 IP 被风控）：请导出 YouTube 的 cookies.txt 放到 data/cookies/cookies.txt（详见 README）'
    if 'unsupported url' in low:
        return '不支持这个网站或链接格式'
    if 'private' in low:
        return '视频是私密的，无法解析'
    if 'not available in your country' in low or 'geo' in low:
        return '视频有地区限制，服务器所在地区无法观看'
    if 'members-only' in low or 'premium' in low or 'paid' in low:
        return '这是付费 / 会员视频，需要在 cookies.txt 里提供有权限的账号'
    if 'timed out' in low or 'timeout' in low:
        return '连接视频网站超时'
    m = re.search(r'HTTP Error (\d{3})', msg)
    if m:
        return f'视频网页打不开（HTTP {m.group(1)}），请检查链接是否正确、视频是否已删除'
    return '解析失败：' + msg[:200]


def resolve(url):
    if not re.match(r'^https?://', url, re.I):
        raise ResolveError('只支持 http/https 链接')
    host = (urllib.parse.urlparse(url).hostname or '').lower()
    if re.search(r'(^|\.)(bilibili\.com|b23\.tv|bili2233\.cn)$', host):
        try:
            return resolve_bilibili(url)
        except NotHandled:
            pass
    return resolve_ytdlp(url)


# ---------------- HTTP 服务 ----------------
cache = {}  # url -> (expire_ts, result)
cache_lock = threading.Lock()
busy = 0
started = time.time()


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global busy
        u = urllib.parse.urlparse(self.path)
        if u.path == '/healthz':
            return self.send_json(200, {'ok': True, 'yt_dlp': yt_dlp.version.__version__, 'cookies': os.path.isfile(COOKIES)})
        if u.path != '/resolve':
            return self.send_json(404, {'error': 'not found'})
        url = (urllib.parse.parse_qs(u.query).get('url') or [''])[0].strip()
        now = time.time()
        with cache_lock:
            hit = cache.get(url)
            if hit and hit[0] > now:
                return self.send_json(200, hit[1])
        busy += 1
        t0 = time.time()
        try:
            res = resolve(url)
            with cache_lock:
                ttl = min(600, res['expires_at'] - now - 600)
                if ttl > 0 and not res.get('is_live'):
                    cache[url] = (now + ttl, res)
                if len(cache) > 500:
                    cache.clear()
            print(f'OK {time.time() - t0:.1f}s {res["extractor"]} {res["kind"]} {res.get("height")}p {url}', flush=True)
            self.send_json(200, res)
        except ResolveError as e:
            print(f'FAIL {url}: {e}', flush=True)
            self.send_json(422, {'error': str(e)})
        except Exception as e:  # 网络错误、网站改版等
            print(f'ERROR {url}: {e!r}', flush=True)
            self.send_json(422, {'error': explain(str(e))})
        finally:
            busy -= 1

    def log_message(self, *args):
        pass


def restarter():
    # 每隔一段时间在空闲时退出，docker 重启容器时入口脚本会顺便更新 yt-dlp（网站改版后旧版常会失效）
    while True:
        time.sleep(600)
        if RESTART_HOURS > 0 and time.time() - started > RESTART_HOURS * 3600 and busy == 0:
            print('定期重启以更新 yt-dlp', flush=True)
            os._exit(0)


if __name__ == '__main__':
    threading.Thread(target=restarter, daemon=True).start()
    print(f'resolver listening on :{PORT}, yt-dlp {yt_dlp.version.__version__}, cookies: {os.path.isfile(COOKIES)}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()

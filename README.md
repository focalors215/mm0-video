# MM0 一起看 (mm0-video)

多人同步观看视频/电影的网站：创建房间 → 分享链接 → 所有人的播放、暂停、拖动进度、倍速自动同步，附带房间聊天。

## 功能
- 房间制，邀请链接一键复制；首页「公开房间」大厅，可设置房间名称、公开、密码
- 播放 / 暂停 / 跳转 / 倍速 实时同步，定期自动纠正进度漂移
- 播放列表：加入列表、调整顺序、播完自动下一个；顺序 / 列表循环 / 单集循环 / 随机；播放历史一键重看
- 支持视频直链（mp4 / webm）、HLS（m3u8，可选画质）、HTTP-FLV（flv）、DASH（mpd）
- 支持上传本地视频（默认上限 10GB，可拖动进度条）
- 字幕：上传 SRT / ASS / VTT 字幕（自动识别 GBK 编码），房间里所有人同步加载
- 聊天 + 弹幕：聊天消息以弹幕飘过画面，全屏时也能看弹幕、发弹幕；新进房间能看到最近 100 条聊天
- 房主 / 管理员：设置管理员、转让房主、踢人（5 分钟内不能再进）、「仅房主和管理员可控制播放」
- 防盗链：可给链接设置 Referer / Cookie 等请求头，由服务器中转播放（请求头不会发给其他成员）；跨域（CORS）的 m3u8 也能中转
- 自由模式：自己随便拖进度，不影响别人，随时一键同步回房间进度
- 语音聊天（WebRTC，最多 8 人，需要 https）
- 画中画
- 播放失败时直接在播放器上显示原因（需要登录、防盗链、链接失效、不是视频文件、编码不支持、Safari 不兼容等）
- Safari / iPhone / 微信等浏览器遇到文件类型不对的网盘直链时，自动改为服务器中转播放（只中转房间里正在播放的视频，流量经过服务器）

## 一键部署
在服务器上运行（需要 root 或 sudo；没装 Docker 会自动安装，代码装到 `/opt/mm0-video`）：
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/focalors215/mm0-video/main/deploy.sh)
```
自定义端口或安装目录：
```bash
PORT=8080 INSTALL_DIR=/opt/mm0-video bash <(curl -fsSL https://raw.githubusercontent.com/focalors215/mm0-video/main/deploy.sh)
```
已经克隆了仓库的话，在项目目录里直接运行：
```bash
bash deploy.sh
```
部署完成后访问 `http://服务器IP:3000`。

## 一键更新
拉取最新代码并重建容器，上传的视频和 `.env` 配置都会保留：
```bash
bash /opt/mm0-video/update.sh
```
没有新代码时也想强制重建：
```bash
FORCE=1 bash /opt/mm0-video/update.sh
```

## 手动部署
```bash
git clone https://github.com/focalors215/mm0-video.git
cd mm0-video
docker compose up -d --build
```

## 配置
可选环境变量（写在项目目录的 `.env` 里，修改后运行 `FORCE=1 bash update.sh` 生效）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 对外端口 |
| `MAX_UPLOAD_GB` | 10 | 单个上传文件大小上限 |
| `ICE_SERVERS` | 小米 + Google STUN | 语音聊天用的 STUN/TURN 服务器，JSON，例如 `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`。双方都在复杂 NAT 后面时需要 TURN 才能连通 |

上传的视频保存在 `./data/uploads`，字幕在 `./data/uploads/subs`。

> 语音聊天需要通过 https 访问本站（浏览器只允许在 https 下使用麦克风），可以用 Nginx / Caddy 反向代理并申请证书。

> 若放在 Nginx 反向代理后面，需开启 WebSocket 转发（`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`），并调大 `client_max_body_size`。

## 本地开发
```bash
npm install
npm start
```

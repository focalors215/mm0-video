# MM0 一起看 (mm0-video)

多人同步观看视频/电影的网站：创建房间 → 分享链接 → 所有人的播放、暂停、拖动进度、倍速自动同步，附带房间聊天。

## 功能
- 房间制，邀请链接一键复制
- 播放 / 暂停 / 跳转 / 倍速 实时同步，定期自动纠正进度漂移
- 支持视频直链（mp4 / webm）和 HLS（m3u8）
- 支持上传本地视频（默认上限 10GB，可拖动进度条）
- 在线成员列表 + 聊天
- 播放失败时直接在播放器上显示原因（需要登录、防盗链、链接失效、不是视频文件、编码不支持、Safari 不兼容等）

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

上传的视频保存在 `./data/uploads`。

> 若放在 Nginx 反向代理后面，需开启 WebSocket 转发（`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`），并调大 `client_max_body_size`。

## 本地开发
```bash
npm install
npm start
```

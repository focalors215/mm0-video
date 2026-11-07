# MM0 一起看 (mm0-video)

多人同步观看视频/电影的网站：创建房间 → 分享链接 → 所有人的播放、暂停、拖动进度、倍速自动同步，附带房间聊天。

## 功能
- 房间制，邀请链接一键复制
- 播放 / 暂停 / 跳转 / 倍速 实时同步，定期自动纠正进度漂移
- 支持视频直链（mp4 / webm）和 HLS（m3u8）
- 支持上传本地视频（默认上限 10GB，可拖动进度条）
- 在线成员列表 + 聊天

## Docker 部署
```bash
git clone git@github.com:<你的用户名>/mm0-video.git
cd mm0-video
docker compose up -d --build
```
访问 `http://服务器IP:3000`。

可选环境变量（写在 `.env` 里）：

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

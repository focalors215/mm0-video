#!/bin/sh
# 启动前更新 yt-dlp：视频网站经常改版，旧版本很快会失效。网络不好时最多等 90 秒，失败就用镜像里自带的版本。
if [ "${AUTO_UPDATE:-1}" = "1" ]; then
  timeout 90 pip install -q --no-cache-dir --disable-pip-version-check --root-user-action=ignore -U "yt-dlp[default]" 2>&1 | tail -n 2 || true
fi
exec python app.py

#!/usr/bin/env bash
# MM0 一起看 - 一键更新脚本：拉取最新代码并重建容器（上传的视频和 .env 会保留）
# 用法：bash update.sh   （默认更新脚本所在目录，或设置 INSTALL_DIR）
set -euo pipefail

info() { echo -e "\033[32m[mm0]\033[0m $*"; }
die()  { echo -e "\033[31m[mm0] 错误：\033[0m $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then APP_DIR="$SCRIPT_DIR"; else APP_DIR="${INSTALL_DIR:-/opt/mm0-video}"; fi
[ -d "$APP_DIR/.git" ] || die "$APP_DIR 不是项目目录，请先运行 deploy.sh"
cd "$APP_DIR"

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
docker info >/dev/null 2>&1 || DC="sudo $DC"

OLD="$(git rev-parse --short HEAD)"
info "拉取最新代码…"
git pull --ff-only || die "拉取失败。若本地改过代码，请先 git stash 或提交后再更新"
NEW="$(git rev-parse --short HEAD)"

if [ "$OLD" = "$NEW" ] && [ "${FORCE:-0}" != "1" ]; then
  info "已经是最新版本（$NEW），无需更新。强制重建：FORCE=1 bash update.sh"
  exit 0
fi
[ "$OLD" != "$NEW" ] && { info "更新内容 $OLD → $NEW："; git log --oneline "$OLD..$NEW"; }

info "重建并重启容器…"
$DC up -d --build
docker image prune -f >/dev/null 2>&1 || true

PORT_NOW="$(grep -sE '^PORT=' .env | cut -d= -f2)"; PORT_NOW="${PORT_NOW:-3000}"
for i in $(seq 1 30); do
  curl -fs "http://127.0.0.1:${PORT_NOW}/healthz" >/dev/null 2>&1 && { info "更新完成，当前版本 $NEW"; exit 0; }
  sleep 1
done
$DC logs --tail 50
die "服务未在 30 秒内就绪，请查看上方日志"

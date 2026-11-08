#!/usr/bin/env bash
# MM0 一起看 - 一键部署脚本
# 用法：bash deploy.sh            （在项目目录内运行）
#   或：bash <(curl -fsSL https://raw.githubusercontent.com/focalors215/mm0-video/main/deploy.sh)
# 可选环境变量：INSTALL_DIR（默认 /opt/mm0-video）、PORT（默认 3000）、MAX_UPLOAD_GB（默认 10）
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/focalors215/mm0-video.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/mm0-video}"

info() { echo -e "\033[32m[mm0]\033[0m $*"; }
die()  { echo -e "\033[31m[mm0] 错误：\033[0m $*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

# 1. 检查 / 安装依赖
if ! command -v git >/dev/null; then
  info "安装 git…"
  if   command -v apt-get >/dev/null; then $SUDO apt-get update -y && $SUDO apt-get install -y git
  elif command -v dnf     >/dev/null; then $SUDO dnf install -y git
  elif command -v yum     >/dev/null; then $SUDO yum install -y git
  elif command -v pacman  >/dev/null; then $SUDO pacman -Sy --noconfirm git
  elif command -v apk     >/dev/null; then $SUDO apk add git
  else die "请先手动安装 git"; fi
fi
if ! command -v docker >/dev/null; then
  info "未检测到 Docker，正在通过官方脚本安装…"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker 2>/dev/null || true
fi
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null; then DC="docker-compose"
else die "未找到 docker compose，请安装 docker-compose-plugin"; fi
docker info >/dev/null 2>&1 || { DC="$SUDO $DC"; $SUDO docker info >/dev/null 2>&1 || die "Docker 未运行"; }

# 2. 获取代码：脚本在项目目录内则直接用，否则克隆到 INSTALL_DIR
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/server.js" ]; then
  APP_DIR="$SCRIPT_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  APP_DIR="$INSTALL_DIR"; info "目录已存在，拉取最新代码…"; git -C "$APP_DIR" pull --ff-only
else
  info "克隆代码到 $INSTALL_DIR …"
  $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
  $SUDO git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  [ -n "$SUDO" ] && $SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
  APP_DIR="$INSTALL_DIR"
fi
cd "$APP_DIR"

# 3. 配置
if [ ! -f .env ]; then
  printf 'PORT=%s\nMAX_UPLOAD_GB=%s\n' "${PORT:-3000}" "${MAX_UPLOAD_GB:-10}" > .env
  info "已生成 .env（端口 ${PORT:-3000}），可编辑后运行 update.sh 生效"
fi
mkdir -p data/uploads data/cookies
PORT_NOW="$(grep -E '^PORT=' .env | cut -d= -f2)"; PORT_NOW="${PORT_NOW:-3000}"

# 4. 构建并启动
info "构建并启动容器…"
$DC up -d --build

# 5. 健康检查
for i in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:${PORT_NOW}/healthz" >/dev/null 2>&1; then
    IP="$(curl -fs --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
    info "部署成功！访问：http://${IP:-服务器IP}:${PORT_NOW}"
    info "项目目录：$APP_DIR    更新：bash $APP_DIR/update.sh"
    exit 0
  fi
  sleep 1
done
$DC logs --tail 50
die "服务未在 30 秒内就绪，请查看上方日志"

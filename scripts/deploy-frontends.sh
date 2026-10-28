#!/usr/bin/env bash
# 部署某家店的兩個前端（學員 LIFF ＋ 業主後台）到 Cloudflare Pages
#
#   bash scripts/deploy-frontends.sh <slug> <tenantId> <liffId> [liff|admin]
#
#   例：bash scripts/deploy-frontends.sh suli 0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d 2010061490-DycuG3uU
#   網址：https://<slug>-liff.pages.dev、https://<slug>-admin.pages.dev
#
# 為什麼要複製到 C:\deploy：專案路徑有中文與 @，vite build 會直接當掉（0xC0000409）、
# wrangler 也會出錯（見 CLAUDE.md 2026-09-29）。
# 每家店的 tenantId / LIFF ID 是建置時寫進去的，所以每家店各建一份。
set -e

SLUG="$1"; TENANT="$2"; LIFF="$3"; ONLY="${4:-all}"
API="https://line-booking-saas-production.up.railway.app"
if [ -z "$SLUG" ] || [ -z "$TENANT" ]; then
  echo "用法：bash scripts/deploy-frontends.sh <slug> <tenantId> <liffId> [liff|admin]"; exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # Git Bash 路徑，給 robocopy 前用 cygpath -w 轉

build_and_deploy () {
  local SRC="$1" PROJECT="$2" ENVTEXT="$3"
  local DEST="C:/deploy/$PROJECT"
  echo ""; echo "=== $PROJECT ==="
  # robocopy 成功時回傳 1，>= 8 才是錯誤
  robocopy "$(cygpath -w "$ROOT/$SRC")" "$(cygpath -w "$DEST")" \
    /MIR /XD node_modules dist .wrangler /XF .env /NFL /NDL /NJH /NJS /NP > /dev/null || [ $? -lt 8 ]
  printf "%s\n" "$ENVTEXT" > "$DEST/.env"
  cd "$DEST"
  [ -d node_modules ] || npm install --no-audit --no-fund > /dev/null
  npx vite build 2>&1 | tail -3
  # 第一次部署要先建專案；已存在會回錯誤，忽略
  npx wrangler pages project create "$PROJECT" --production-branch=main > /dev/null 2>&1 || true
  npx wrangler pages deploy dist --project-name="$PROJECT" --commit-dirty=true 2>&1 | tail -2
  cd - > /dev/null
}

if [ "$ONLY" = "all" ] || [ "$ONLY" = "liff" ]; then
  [ -n "$LIFF" ] || { echo "缺少 LIFF ID"; exit 1; }
  build_and_deploy "frontend" "$SLUG-liff" "VITE_API_URL=$API
VITE_LIFF_ID=$LIFF
VITE_TENANT_ID=$TENANT"
fi
if [ "$ONLY" = "all" ] || [ "$ONLY" = "admin" ]; then
  build_and_deploy "admin-frontend" "$SLUG-admin" "VITE_API_URL=$API
VITE_TENANT_ID=$TENANT"
fi
echo ""; echo "完成：https://$SLUG-liff.pages.dev ／ https://$SLUG-admin.pages.dev"

#!/usr/bin/env bash
# 安装到指定 DSH profile（默认 desktop），并提示重启。
set -euo pipefail
PROFILE="${1:-desktop}"
BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PKG="$(cd "$(dirname "$0")/.." && pwd)"
"$BIN" plugin --profile "$PROFILE" add "$PKG"
echo
echo "已安装到 profile: $PROFILE"
echo "请刷新 DSH 页面（⌘R）；若没有出现「📖 论文」按钮，请重启 DSH 应用。"

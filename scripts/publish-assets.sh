#!/usr/bin/env bash
# scripts/publish-assets.sh — 发布 build/assets 下的资源包（先执行 scripts/build-assets.mjs）
# 每个包都会让 npm 要一次两步验证码。已发布过的同版本会跳过。
set -euo pipefail
cd "$(dirname "$0")/../build/assets"
for d in */; do
  name="${d%/}"
  version=$(node -p "require('./$name/package.json').version")
  if npm view "$name@$version" version >/dev/null 2>&1; then echo "skip $name@$version (already published)"; continue; fi
  (cd "$name" && npm publish --access public)
done

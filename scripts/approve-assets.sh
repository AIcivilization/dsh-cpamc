#!/usr/bin/env bash
# scripts/approve-assets.sh — 批准 GitHub Actions 暂存的资源包（dsh-cpamc-assets-*），每个包输一次两步验证码
# npm 的新规则下，CI 只能「暂存发布」；批准后版本才正式上线。不需要重新上传文件。
set -euo pipefail
NPM="npx -y npm@11"
version=$(node -p "require('$(dirname "$0")/../engine-manifest.json').npm.version")
for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do
  name="dsh-cpamc-assets-$t"
  if npm view "$name@$version" version >/dev/null 2>&1; then echo "✓ $name@$version already published"; continue; fi
  ids=$($NPM stage list "$name" --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j = []; try { j = JSON.parse(s || "[]") } catch {}
      const list = Array.isArray(j) ? j : (j.staged || j.objects || Object.values(j))
      for (const x of list) if (x && (x.version === undefined || x.version === process.argv[1])) console.log(x.id ?? x.stageId ?? x.stage_id ?? "")
    })' "$version")
  if [ -z "$ids" ]; then echo "! $name: nothing staged (run the assets workflow first)"; continue; fi
  for id in $ids; do
    [ -n "$id" ] || continue
    echo "→ approving $name ($id)"
    $NPM stage approve "$id"
  done
done

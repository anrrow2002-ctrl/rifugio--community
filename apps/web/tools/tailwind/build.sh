#!/bin/bash
# 重新生成 apps/web/vendor/tailwind.css
# 什么时候需要跑：index.html 或 js/ 里用了以前没用过的 Tailwind utility class 之后
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install tailwindcss@3.4 --no-audit --no-fund
npx tailwindcss -c tailwind.config.js -i input.css -o ../../vendor/tailwind.css --minify
echo "done → apps/web/vendor/tailwind.css （记得 bump index.html 里 tailwind.css 的 ?v=）"

#!/bin/sh
# Rebuilds the viewer bundle and copies it into the Android app assets.
# Needs Node.js:  npm install  &&  sh build-web.sh
set -e
cd "$(dirname "$0")"
npx esbuild src/app.js --bundle --format=iife --minify --target=chrome80 \
  --loader:.png=dataurl --outfile=dist/app.js --log-level=warning
cp index.html dist/index.html
cp dist/index.html dist/app.js ../app/src/main/assets/
echo "assets updated"

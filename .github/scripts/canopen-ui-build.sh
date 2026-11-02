#!/bin/bash
# Builds the editor for tests: production mode without minification or source maps, with webpack's
# filesystem cache in node_modules/.cache/webpack. Release packaging keeps `npm run build`.
set -euo pipefail

cache=node_modules/.cache/webpack
echo "webpack cache before: $(du -sh "$cache"/* 2>/dev/null | tr '\n' ' ')"
flags='--no-optimization-minimize --no-devtool --cache-type filesystem --infrastructure-logging-level verbose'
npx concurrently --kill-others-on-fail --names main,renderer \
    "npm run build:main -- $flags --cache-name main" \
    "npm run build:renderer -- $flags --cache-name renderer"
echo "webpack cache after: $(du -sh "$cache"/* | tr '\n' ' ')"

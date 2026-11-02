#!/bin/bash
# Builds the editor for tests: production mode without minification or source maps, with webpack's
# filesystem cache in node_modules/.cache/webpack. Release packaging keeps `npm run build`.
set -euo pipefail

flags='--no-optimization-minimize --no-devtool --cache-type filesystem'
npx concurrently --kill-others-on-fail --names main,renderer \
    "npm run build:main -- $flags --cache-name main" \
    "npm run build:renderer -- $flags --cache-name renderer"

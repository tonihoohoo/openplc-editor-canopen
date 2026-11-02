#!/bin/bash
# Builds the editor for tests: production mode without minification, source maps or module
# concatenation, which take most of a production build's time. Release packaging keeps `npm run build`.
set -euo pipefail

flags='--no-optimization-minimize --no-devtool --no-optimization-concatenate-modules'
npx concurrently --kill-others-on-fail --names main,renderer \
    "npm run build:main -- $flags" \
    "npm run build:renderer -- $flags"

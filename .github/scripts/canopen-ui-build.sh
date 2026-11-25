#!/bin/bash
# Builds the editor for tests: production mode without minification, source maps or module
# concatenation, which take most of a production build's time. Release packaging keeps `npm run build`.
# The steps are those of `npm run build`, with the webpack flags given to the two webpack runs only and
# without package-trust verify-bundle, which needs a minified bundle (release builds still run it).
set -euo pipefail

flags='--no-optimization-minimize --no-devtool --no-optimization-concatenate-modules'
npm run setup:hmi-widgets
npm run build:hmi-objects
main="TS_NODE_TRANSPILE_ONLY=true npx ts-node scripts/prepare-yowasp-clang.ts \
&& npx ts-node --transpile-only scripts/package-trust/cli.ts prepare \
&& NODE_ENV=production TS_NODE_TRANSPILE_ONLY=true npx webpack --config ./configs/webpack/webpack.config.main.prod.ts $flags"
npx concurrently --kill-others-on-fail --names main,renderer \
    "$main" \
    "npm run build:renderer -- $flags"

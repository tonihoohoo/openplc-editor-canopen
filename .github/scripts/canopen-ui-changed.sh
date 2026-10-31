#!/bin/bash
# Writes ui=true to $GITHUB_OUTPUT when the CANopen UI tests should run: the pull request changes a
# path under src/ or e2e/ with "canopen" in it, an e2e helper, the dependencies, the Playwright
# config or these CI files, or it merges an upstream release (head branch main or sync/*). Any
# other event (workflow_dispatch) writes ui=true.
set -euo pipefail

ui=true
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
    ui=false
    case "${HEAD_REF:-}" in
        main | sync/*) ui=true ;;
    esac
    files=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[].filename')
    while IFS= read -r file; do
        lower=$(printf '%s' "$file" | tr '[:upper:]' '[:lower:]')
        case "$lower" in
            src/*canopen* | e2e/*canopen* | e2e/helpers/*) ui=true ;;
            package.json | package-lock.json | playwright.config.ts) ui=true ;;
            .github/workflows/canopen-ui.yml | .github/scripts/canopen-ui-*) ui=true ;;
        esac
    done <<<"$files"
    echo "Changed files:"
    echo "$files"
fi
echo "ui=$ui"
echo "ui=$ui" >>"${GITHUB_OUTPUT:-/dev/stdout}"

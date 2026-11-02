#!/bin/bash
# Writes run=true to $GITHUB_OUTPUT when the CANopen DBC cross-check should run: the pull request
# changes the DBC writer, the export code, the model it reads, its tests or the cross-check files.
# Any other event (workflow_dispatch) writes run=true.
set -euo pipefail

run=true
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
    run=false
    files=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[].filename')
    dir=src/middleware/shared/utils/canopen
    while IFS= read -r file; do
        case "$file" in
            "$dir"/dbc-* | "$dir"/device-export* | "$dir"/__tests__/dbc-*) run=true ;;
            "$dir"/__tests__/fixtures/helpers.ts | "$dir"/__tests__/fixtures/generic-io-module.eds) run=true ;;
            .github/workflows/canopen-dbc-crosscheck.yml | .github/scripts/canopen-dbc-* | .github/scripts/canopen_dbc_*) run=true ;;
        esac
    done <<<"$files"
    echo "Changed files:"
    echo "$files"
fi
echo "run=$run"
echo "run=$run" >>"${GITHUB_OUTPUT:-/dev/stdout}"

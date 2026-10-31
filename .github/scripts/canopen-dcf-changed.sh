#!/bin/bash
# Writes run=true to $GITHUB_OUTPUT when the CANopen DCF cross-check should run: the pull request
# changes the CiA 306 check, the EDS parser, the DCF import or export code, their fixtures or the
# cross-check files. Any other event (workflow_dispatch) writes run=true.
set -euo pipefail

run=true
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
    run=false
    files=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[].filename')
    dir=src/middleware/shared/utils/canopen
    while IFS= read -r file; do
        case "$file" in
            "$dir"/eds-* | "$dir"/dcf-* | "$dir"/device-file* | "$dir"/device-import*) run=true ;;
            "$dir"/__tests__/fixtures/cia306/* | "$dir"/__tests__/fixtures/helpers.ts) run=true ;;
            "$dir"/__tests__/dcf-crosscheck-writer.test.ts) run=true ;;
            .github/workflows/canopen-dcf-crosscheck.yml | .github/scripts/canopen-dcf-* | .github/scripts/canopen_dcf_*) run=true ;;
        esac
    done <<<"$files"
    echo "Changed files:"
    echo "$files"
fi
echo "run=$run"
echo "run=$run" >>"${GITHUB_OUTPUT:-/dev/stdout}"

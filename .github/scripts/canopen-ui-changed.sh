#!/bin/bash
# Writes ui, slave and master to $GITHUB_OUTPUT: whether the CANopen UI tests run, and which sets.
# A pull request runs them when it changes a path under src/ or e2e/ with "canopen" in it, an e2e
# helper, the dependencies, the Playwright config or these CI files, or merges an upstream release
# (head branch main or sync/*). canopen-ui-groups.mjs picks the slave set, the master set or both
# from the changed files. Upstream syncs and any other event (workflow_dispatch) run both sets.
set -euo pipefail

slave=true
master=true
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
    files=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[].filename')
    echo "Changed files:"
    echo "$files"
    case "${HEAD_REF:-}" in
        main | sync/*) ;;
        *)
            groups=$(printf '%s\n' "$files" | node "$(dirname "$0")/canopen-ui-groups.mjs")
            echo "Groups:"
            echo "$groups"
            slave=$(printf '%s\n' "$groups" | sed -n 's/^slave=//p')
            master=$(printf '%s\n' "$groups" | sed -n 's/^master=//p')
            ;;
    esac
fi
ui=false
if [ "$slave" = true ] || [ "$master" = true ]; then ui=true; fi
for line in "ui=$ui" "slave=$slave" "master=$master"; do
    echo "$line"
    echo "$line" >>"${GITHUB_OUTPUT:-/dev/stdout}"
done

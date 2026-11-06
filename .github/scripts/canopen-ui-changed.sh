#!/bin/bash
# Writes the CANopen UI test choice to $GITHUB_OUTPUT: ui, specs, chosen, slave, master, shards and
# matrix (see canopen-ui-select.mjs). A pull request is judged by its changed files; when its latest
# push changed only CANopen specs or baseline images, the base has not moved and the previous run
# left its selection artifact, only that push's files and the previously failed specs count.
# Upstream syncs (head branch main or sync/*), pushes and runs started by hand run every spec.
# Needs GH_TOKEN, GITHUB_REPOSITORY, and on pull requests PR_NUMBER, HEAD_REF, HEAD_SHA, BASE_SHA.
set -euo pipefail

here="$(dirname "$0")"
select=(node "$here/canopen-ui-select.mjs")
node "$here/canopen-ui-select.mjs" --check

push_only() {
    # The previous completed, not cancelled run of this workflow for the branch, other than this head.
    local prev dir files
    prev=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow canopen-ui.yml --branch "$HEAD_REF" \
        --event pull_request --status completed --limit 20 --json databaseId,headSha,conclusion \
        --jq "[.[] | select(.conclusion != \"cancelled\" and .conclusion != \"skipped\" and .headSha != \"$HEAD_SHA\")][0].databaseId // empty")
    [ -n "$prev" ] || return 1
    dir=$(mktemp -d)
    gh run download "$prev" --repo "$GITHUB_REPOSITORY" -n canopen-ui-selection -D "$dir" 2>/dev/null || return 1
    [ "$(cat "$dir/base")" = "$BASE_SHA" ] || { echo "Base moved since run $prev."; return 1; }
    local status
    status=$(gh api "repos/$GITHUB_REPOSITORY/compare/$(cat "$dir/head")...$HEAD_SHA" --jq .status) || return 1
    [ "$status" = ahead ] || { echo "Head is $status of run $prev's head."; return 1; }
    files=$(gh api --paginate "repos/$GITHUB_REPOSITORY/compare/$(cat "$dir/head")...$HEAD_SHA" --jq '.files[].filename')
    [ -n "$files" ] || return 1
    while IFS= read -r file; do
        [[ "$file" =~ ^e2e/canopen-[^/]+\.spec\.ts(-snapshots/.*)?$ ]] || { echo "Push changes $file."; return 1; }
    done <<<"$files"
    echo "Push after run $prev changed only specs or baselines:"
    echo "$files"
    PUSH_FILES="$files"
    PUSH_FAILED=$(tr '\n' ',' <"$dir/failed")
    return 0
}

if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] && [[ ! "${HEAD_REF:-}" =~ ^(main|sync/.*)$ ]]; then
    PUSH_FILES=""
    PUSH_FAILED=""
    if push_only; then
        result=$(printf '%s\n' "$PUSH_FILES" | "${select[@]}" --also "$PUSH_FAILED")
    else
        files=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[].filename')
        echo "Changed files:"
        echo "$files"
        result=$(printf '%s\n' "$files" | "${select[@]}")
    fi
else
    result=$("${select[@]}" --all </dev/null)
fi

echo "$result"
specs=$(sed -n 's/^specs=//p' <<<"$result")
shards=$(sed -n 's/^shards=//p' <<<"$result")
ui=false
[ -n "$specs" ] && ui=true
matrix=$(seq -s, 1 "$shards")
{
    echo "ui=$ui"
    grep -E '^(specs|chosen|slave|master|shards)=' <<<"$result"
    echo "matrix=[$matrix]"
} | tee -a "${GITHUB_OUTPUT:-/dev/stdout}"

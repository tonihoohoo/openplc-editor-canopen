#!/bin/bash
# Writes docs_only=true to $GITHUB_OUTPUT when the pull request changes only Markdown files or
# files under docs/ or examples/, so the test jobs can be skipped. It is also true when the latest push changed only
# files under e2e/, the base has not moved and the previous run of this workflow for the branch passed
# (its ci-base artifact holds that run's head and base). Any other event writes docs_only=false.
# Needs GH_TOKEN, GITHUB_REPOSITORY, and on pull requests PR_NUMBER, HEAD_REF, HEAD_SHA, BASE_SHA.
set -euo pipefail

e2e_push() {
    local prev dir status files
    prev=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch "$HEAD_REF" \
        --event pull_request --status completed --limit 20 --json databaseId,headSha,conclusion \
        --jq "[.[] | select(.conclusion != \"cancelled\" and .conclusion != \"skipped\" and .headSha != \"$HEAD_SHA\")][0] | select(.conclusion == \"success\") | .databaseId // empty")
    [ -n "$prev" ] || return 1
    dir=$(mktemp -d)
    gh run download "$prev" --repo "$GITHUB_REPOSITORY" -n ci-base -D "$dir" 2>/dev/null || return 1
    [ "$(cat "$dir/base")" = "$BASE_SHA" ] || { echo "Base moved since run $prev."; return 1; }
    status=$(gh api "repos/$GITHUB_REPOSITORY/compare/$(cat "$dir/head")...$HEAD_SHA" --jq .status) || return 1
    [ "$status" = ahead ] || { echo "Head is $status of run $prev's head."; return 1; }
    files=$(gh api --paginate "repos/$GITHUB_REPOSITORY/compare/$(cat "$dir/head")...$HEAD_SHA" --jq '.files[].filename')
    [ -n "$files" ] || return 1
    while IFS= read -r file; do
        [[ "$file" == e2e/* ]] || { echo "Push changes $file."; return 1; }
    done <<<"$files"
    echo "Push after passing run $prev changed only e2e files:"
    echo "$files"
    return 0
}

docs_only=false
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
    files=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[].filename')
    if [ -n "$files" ]; then
        docs_only=true
        while IFS= read -r file; do
            case "$file" in
                *.md | docs/* | examples/*) ;;
                *) docs_only=false ;;
            esac
        done <<<"$files"
    fi
    echo "Changed files:"
    echo "$files"
    if [ "$docs_only" = false ] && [ -n "${HEAD_SHA:-}" ] && e2e_push; then
        docs_only=true
    fi
fi
echo "docs_only=$docs_only"
echo "docs_only=$docs_only" >>"${GITHUB_OUTPUT:-/dev/stdout}"

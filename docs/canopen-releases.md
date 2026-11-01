# CANopen releases

This fork publishes its own releases with `.github/workflows/canopen-release.yml`. Upstream's
`release.yml` is disabled in the fork's Actions settings and stays unchanged in the repository.

## Versions

A release is a tag `v<upstream version>-canopen.<N>` on a commit of `canopen`. The upstream version
is the one in `package.json` (the upstream release `canopen` contains); N starts at 1 for each upstream
version. `v4.3.3-canopen.2` follows `v4.3.3-canopen.1`, and after upstream 4.3.4 is merged the next
release is `v4.3.4-canopen.1`.

- Never push a tag without `-canopen.`: it would sort above every fork release of that version.
- Never move, delete or reuse a tag. A broken release is followed by the next N.
- `APP_VERSION` and `package.json` stay upstream's in the repository; the workflow writes the tag into
  both in its build checkout, so the installers and the About dialog show it.

## Making a release

- **By hand**: Actions, **CANopen release**, **Run workflow** on `canopen`. Optional notes are shown
  above the list of changes; leave the version empty to get the next N. **Dry run** builds the
  installers without creating a tag or a release.
- **By tag**: `git tag v4.3.3-canopen.2 origin/canopen && git push origin v4.3.3-canopen.2`.
- A pull request that changes the workflow or `.github/scripts/canopen_release.py` runs it as a dry run.

The workflow refuses a commit that is not on `canopen` (which only takes pull requests whose required
checks passed), a tag that does not match `package.json` or already exists, and notes that fail the
banned-word check. It then builds six installers in parallel: macOS Intel and Apple silicon, Windows
x64 and arm64, Linux x64 and arm64 AppImages. They keep upstream's file names, so the update notice
picks them. After all six are built it creates the tag (when started by hand) and the GitHub Release
with `SHA256SUMS.txt`, the fork's commits since the previous release and a link to the source at the tag.

The installers are unsigned. The macOS app is signed ad hoc and not notarized: users allow it once in
System Settings, Privacy and Security (**Open Anyway**). Windows shows SmartScreen (**More info**,
**Run anyway**). Installing replaces an installed OpenPLC Editor, which has the same app id. No
`latest*.yml` is ever published: editors 4.1.0 to 4.3.2 would install it without asking.

## Updates

The update notice reads this fork's releases (`RELEASES_API` in `src/main/modules/updater/index.ts`),
downloads only under its `/releases/download/` (`RELEASE_DOWNLOAD_PREFIX` in `release-assets.ts`) and
links its releases page (`RELEASES_URL` in `update-service.ts`). The runtime **Change version** dialog
lists the runtime fork's tags (`TAGS_URL` in `src/middleware/shared/utils/runtime-versions.ts`). Keep
these four lines when merging an upstream release.

## One-time setup

- Default branch `canopen`, so **Run workflow** finds the workflow.
- Disable `release.yml` in the Actions settings.
- A tag ruleset on `v*`: only the owner and GitHub Actions create tags; updates and deletions blocked.

## After an upstream release

1. Sync `main` and merge it into `canopen` in its own pull request from a `sync/upstream-<version>`
   branch, keeping the four lines above. That branch name makes the CANopen UI tests run on it.
2. Disable any new release or publish workflow upstream added.
3. Release with N back at 1 on the new upstream version.

#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Publish the CANopen UI tests' screenshots and report them on the pull request.

Run by ``.github/workflows/canopen-ui.yml`` after the tests, passed or failed:

  canopen_ui_report.py --results test-results --outcome failure --slave true --master false \
      --chosen "e2e/canopen-online.spec.ts"

1. Collects the named screenshots (``test-results/canopen-shots/<spec>/*.png``) and, for every key
   view whose comparison failed, Playwright's ``-expected``, ``-actual`` and ``-diff`` images.
2. Commits them to the ``ci-screenshots`` branch under ``pr-<number>/<run id>/``. The branch is one
   orphan commit, rebuilt on every run: this pull request's older runs and the folders of pull
   requests that are no longer open are dropped, so it stays small.
3. Creates or updates one comment on the pull request, found by a hidden marker, that shows them:
   the differing key views, then the screenshots of the specs the change chose (``--chosen``), and
   the other specs' screenshots (the always-run build spec) in a collapsed list.

Needs ``GH_TOKEN`` (contents and pull requests write), ``GITHUB_REPOSITORY``, ``PR_NUMBER``,
``GITHUB_RUN_ID``, ``GITHUB_SERVER_URL`` and ``HEAD_SHA``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

BRANCH = "ci-screenshots"
MARKER = "<!-- canopen-ui-report -->"
API = "https://api.github.com"


@dataclass
class Changed:
    """A key view whose comparison failed; expected is None for a view with no baseline yet."""

    name: str
    actual: Path
    expected: Optional[Path]
    diff: Optional[Path]


def api(method: str, path: str, token: str, body: Optional[dict] = None) -> object:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as res:
        text = res.read().decode()
    return json.loads(text) if text else None


def api_pages(path: str, token: str) -> List[dict]:
    items: List[dict] = []
    page = 1
    while True:
        sep = "&" if "?" in path else "?"
        batch = api("GET", f"{path}{sep}per_page=100&page={page}", token)
        if not isinstance(batch, list) or not batch:
            return items
        items.extend(x for x in batch if isinstance(x, dict))
        page += 1


def last_attempts(results: Path) -> List[Path]:
    """Each test's output folder of its last attempt (Playwright adds -retry<N> for a retry)."""
    latest: Dict[str, Tuple[int, Path]] = {}
    for folder in results.iterdir():
        if not folder.is_dir() or folder.name in ("canopen-shots", "canopen-key-views"):
            continue
        match = re.fullmatch(r"(.*)-retry(\d+)", folder.name)
        key, attempt = (match.group(1), int(match.group(2))) if match else (folder.name, 0)
        if key not in latest or attempt > latest[key][0]:
            latest[key] = (attempt, folder)
    return [folder for _, folder in latest.values()]


def collect_changed(results: Path) -> List[Changed]:
    """The failed comparisons of each test's last attempt; a test that passed on a retry has none."""
    found: Dict[str, Changed] = {}
    for folder in last_attempts(results):
        for actual in folder.rglob("*-actual.png"):
            name = actual.name[: -len("-actual.png")]
            expected = actual.with_name(f"{name}-expected.png")
            diff = actual.with_name(f"{name}-diff.png")
            found[name] = Changed(
                name=name,
                actual=actual,
                expected=expected if expected.exists() else None,
                diff=diff if diff.exists() else None,
            )
    return [found[k] for k in sorted(found)]


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def publish(
    repo: str, token: str, pr: int, run: str, shots: List[Path], changed: List[Changed]
) -> Dict[str, str]:
    """Commits the images to the branch and returns their raw URLs by file name."""
    open_prs = {str(p["number"]) for p in api_pages(f"/repos/{repo}/pulls?state=open", token)}
    urls: Dict[str, str] = {}
    for attempt in range(3):
        work = Path(tempfile.mkdtemp())
        git(work, "init", "-q")
        git(work, "config", "user.name", "github-actions[bot]")
        git(work, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
        git(work, "remote", "add", "origin", f"https://x-access-token:{token}@github.com/{repo}.git")
        lease = f"--force-with-lease={BRANCH}:"
        try:
            git(work, "fetch", "-q", "--depth=1", "origin", BRANCH)
            lease += git(work, "rev-parse", "FETCH_HEAD").strip()
            git(work, "checkout", "-q", "FETCH_HEAD")
        except subprocess.CalledProcessError:
            pass  # first run: no branch yet
        for folder in work.glob("pr-*"):
            if folder.name[3:] not in open_prs or folder.name == f"pr-{pr}":
                shutil.rmtree(folder)
        dest = work / f"pr-{pr}" / run
        (dest / "shots").mkdir(parents=True)
        (dest / "changed").mkdir()
        base = f"https://raw.githubusercontent.com/{repo}/{BRANCH}/pr-{pr}/{run}"
        for shot in shots:
            key = shot_key(shot)
            (dest / "shots" / shot.parent.name).mkdir(exist_ok=True)
            shutil.copy(shot, dest / "shots" / key)
            urls[key] = f"{base}/shots/{key}"
        for c in changed:
            for kind, path in (("expected", c.expected), ("actual", c.actual), ("diff", c.diff)):
                if path is not None:
                    file = f"{c.name}-{kind}.png"
                    shutil.copy(path, dest / "changed" / file)
                    urls[file] = f"{base}/changed/{file}"
        (work / "README.md").write_text(
            "Screenshots of the CANopen UI tests, one folder per open pull request. "
            "Rebuilt by .github/workflows/canopen-ui.yml; never merged.\n"
        )
        git(work, "checkout", "-q", "--orphan", "next")
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", f"CANopen UI screenshots, pull request {pr}, run {run}")
        try:
            git(work, "push", "-q", lease, "origin", f"next:refs/heads/{BRANCH}")
            return urls
        except subprocess.CalledProcessError as err:
            print(f"push attempt {attempt + 1} refused: {err.stderr.strip()}", file=sys.stderr)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    raise RuntimeError(f"could not update {BRANCH}")


def shot_key(shot: Path) -> str:
    """``<spec>/<name>.png``: the screenshot's spec folder and file name."""
    return f"{shot.parent.name}/{shot.name}"


def shot_table(shots: List[Path], urls: Dict[str, str]) -> List[str]:
    lines = ["<table>"]
    for i in range(0, len(shots), 2):
        row = shots[i : i + 2]
        cells = "".join(
            f"<td>{img(urls.get(shot_key(s)), s.stem)}<br><code>{s.stem}</code></td>" for s in row
        )
        lines.append(f"<tr>{cells}</tr>")
    return lines + ["</table>", ""]


def img(url: Optional[str], alt: str) -> str:
    return f'<img src="{url}" alt="{alt}" width="400">' if url else "(none)"


def scope(slave: bool, master: bool) -> Tuple[str, str]:
    """The heading's name for the set that ran, and a note on the set that was skipped."""
    if slave and not master:
        return "slave tests", "Only slave specs were chosen: no master file changed."
    if master and not slave:
        return "master tests", "Only master specs were chosen: no slave file or file the slave uses changed."
    return "all tests", ""


def body(
    outcome: str,
    run_url: str,
    sha: str,
    shots: List[Path],
    changed: List[Changed],
    urls: Dict[str, str],
    slave: bool = True,
    master: bool = True,
    chosen: Optional[List[str]] = None,
) -> str:
    title = "passed" if outcome == "success" else "failed"
    name, note = scope(slave, master)
    lines = [MARKER, f"### CANopen UI tests ({name}): {title}", "", f"[Run]({run_url}) on {sha[:7]}."]
    lines += [note, ""] if note else [""]
    if changed:
        lines += [
            "#### Key views that differ from their baseline",
            "",
            "If a change is intended, commit the new image as the baseline "
            "(`e2e/<spec>-snapshots/<view>-chromium-linux.png`, from the run's artifact).",
            "",
            "| View | Baseline | New | Difference |",
            "|---|---|---|---|",
        ]
        for c in changed:
            cells = [img(urls.get(f"{c.name}-{k}.png"), f"{c.name} {k}") for k in ("expected", "actual", "diff")]
            if c.expected is None:
                cells[0] = "no baseline yet"
            lines.append(f"| `{c.name}` | {' | '.join(cells)} |")
        lines.append("")
    stems = None if chosen is None else {Path(c).name[: -len(".spec.ts")] for c in chosen}
    main_shots = [s for s in shots if stems is None or s.parent.name in stems]
    other_shots = [s for s in shots if s not in main_shots]
    specs = sorted({s.parent.name for s in shots})
    lines += [f"Specs that ran: {', '.join(f'`{x}`' for x in specs)}.", ""] if specs else []
    if main_shots:
        lines += ["#### Screenshots of the specs this change chose", ""] + shot_table(main_shots, urls)
    if other_shots:
        lines += [
            "<details><summary>Screenshots of the other specs that ran "
            f"({len(other_shots)})</summary>",
            "",
        ] + shot_table(other_shots, urls) + ["</details>", ""]
    if not shots:
        lines += ["No screenshots: the tests ended before taking any.", ""]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--outcome", required=True)
    parser.add_argument("--slave", default="true", help="whether the slave tests ran (true or false)")
    parser.add_argument("--master", default="true", help="whether the master tests ran (true or false)")
    parser.add_argument("--chosen", default=None, help="the specs the change chose, space-separated")
    args = parser.parse_args()

    token = os.environ["GH_TOKEN"]
    repo = os.environ["GITHUB_REPOSITORY"]
    pr = int(os.environ["PR_NUMBER"])
    run = os.environ["GITHUB_RUN_ID"]
    run_url = f"{os.environ['GITHUB_SERVER_URL']}/{repo}/actions/runs/{run}"
    sha = os.environ["HEAD_SHA"]

    shots = sorted((args.results / "canopen-shots").glob("*/*.png"))
    changed = collect_changed(args.results)
    urls = publish(repo, token, pr, run, shots, changed)
    chosen = None if args.chosen is None else args.chosen.split()
    text = body(
        args.outcome, run_url, sha, shots, changed, urls, args.slave == "true", args.master == "true", chosen
    )

    comments = api_pages(f"/repos/{repo}/issues/{pr}/comments", token)
    mine = [c for c in comments if MARKER in str(c.get("body", ""))]
    if mine:
        api("PATCH", f"/repos/{repo}/issues/comments/{mine[0]['id']}", token, {"body": text})
    else:
        api("POST", f"/repos/{repo}/issues/{pr}/comments", token, {"body": text})
    print(f"Reported {len(shots)} screenshots and {len(changed)} changed key views on #{pr}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

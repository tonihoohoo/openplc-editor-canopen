#!/usr/bin/env python3
"""Prints the CANopen UI spec files (e2e/...) with a failed test in a Playwright JSON report."""

import json
import sys


def failed(suite: dict, out: set[str]) -> None:
    for spec in suite.get("specs", []):
        if not spec.get("ok", True):
            file = spec.get("file") or suite.get("file") or ""
            out.add(file if file.startswith("e2e/") else f"e2e/{file}")
    for child in suite.get("suites", []):
        failed(child, out)


def main(path: str) -> None:
    with open(path, encoding="utf-8") as f:
        report = json.load(f)
    out: set[str] = set()
    for suite in report.get("suites", []):
        failed(suite, out)
    for spec in sorted(out):
        print(spec)


if __name__ == "__main__":
    main(sys.argv[1])

#!/usr/bin/env python3
"""Checks the CiA 311 corpus the editor wrote (xdd/ with verdicts.json) against the CiA 311 v1.1 schema
and against what EdsDcfNet reads from each file.

    canopen_xdd_crosscheck.py <corpus>/xdd --schema <wrapper.xsd> --roundtrip roundtrip-xdd.json

Each fixture must pass or fail the schema as its verdict says; every exported file must pass it. For
an exported XDC, EdsDcfNet must read the same actual values and node ID; for an exported XDD, the
same objects with the same default values. Exits 1 on any difference, naming file, line and element.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Dict, List, Optional, TypedDict


class Verdict(TypedDict, total=False):
    kind: str
    source: str
    schemaValid: bool
    values: Dict[str, str]
    commissioning: Dict[str, Optional[object]]
    objects: Dict[str, str]


def schema_errors(path: str, schema: str) -> List[str]:
    run = subprocess.run(["xmllint", "--noout", "--schema", schema, path], capture_output=True, text=True)
    if run.returncode == 0:
        return []
    lines = [l for l in run.stderr.splitlines() if "validity error" in l or "parser error" in l]
    return lines or [run.stderr.strip() or "xmllint failed"]


def _number(text: str) -> Optional[int]:
    t = text.strip()
    try:
        return int(t, 16) if t.lower().startswith("0x") else int(t)
    except ValueError:
        return None


def same_value(a: str, b: str) -> bool:
    x, y = _number(a), _number(b)
    return x == y if x is not None and y is not None else a.strip() == b.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("corpus")
    parser.add_argument("--schema", required=True)
    parser.add_argument("--roundtrip", required=True)
    args = parser.parse_args()
    with open(os.path.join(args.corpus, "verdicts.json"), encoding="utf-8") as f:
        verdicts: Dict[str, Verdict] = json.load(f)
    with open(args.roundtrip, encoding="utf-8") as f:
        net = {str(e.get("file")): e for e in json.load(f) if isinstance(e, dict)}
    failures: List[str] = []
    for name, verdict in sorted(verdicts.items()):
        errors = schema_errors(os.path.join(args.corpus, name), args.schema)
        want = bool(verdict.get("schemaValid"))
        if want and errors:
            failures += ["%s: CiA 311 schema: %s" % (name, e) for e in errors[:20]]
        elif not want and not errors:
            failures.append("%s: expected to fail the CiA 311 schema, but it passes" % name)
        print("%-40s schema %s" % (name, "valid" if not errors else "invalid (%d)" % len(errors)))
        if verdict.get("kind") != "export":
            continue
        entry = net.get(name)
        if entry is None or "error" in entry:
            failures.append("%s: EdsDcfNet does not read it: %s" % (name, (entry or {}).get("error", "missing")))
            continue
        if name.endswith(".xdc"):
            ours, theirs = verdict.get("values", {}), entry.get("values", {})
            for key in sorted(set(ours) | set(theirs)):
                a, b = ours.get(key), theirs.get(key)
                if a is None or b is None or not same_value(a, b):
                    failures.append("%s: actualValue %s: editor %s, EdsDcfNet %s" % (name, key, a, b))
            node = (verdict.get("commissioning") or {}).get("nodeId")
            if node != (entry.get("commissioning") or {}).get("nodeId"):
                failures.append("%s: node ID: editor %s, EdsDcfNet %s" % (name, node, entry.get("commissioning")))
        else:
            ours, theirs = verdict.get("objects", {}), entry.get("objects", {})
            for key in sorted(set(ours) | set(theirs)):
                a, b = ours.get(key), theirs.get(key)
                if a is None or b is None:
                    failures.append("%s: object %s: only %s reads it" % (name, key, "the editor" if b is None else "EdsDcfNet"))
                elif not same_value(a, b) and not re.match(r"^\$NODEID", a.strip(), re.I):
                    failures.append("%s: default %s: editor %r, EdsDcfNet %r" % (name, key, a, b))
    for f in failures:
        print("FAIL " + f)
    print("%d files, %d differences" % (len(verdicts), len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

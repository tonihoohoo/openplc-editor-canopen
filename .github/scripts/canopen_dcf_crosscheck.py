# SPDX-License-Identifier: Apache-2.0
# classify() and its patterns are from canworks tools/deploy/canworks/edslint.py, commit 9893d1d.
"""Cross-checks the editor's CiA 306 check against two independent checkers.

The corpus folder holds EDS and DCF files and verdicts.json, the editor's verdict on each, written
by src/middleware/shared/utils/canopen/__tests__/dcf-crosscheck-writer.test.ts.

  python canopen_dcf_crosscheck.py lely CORPUS > lely.json
      Runs Lely's dcf-tools lint on every file (run it with the Python that has dcf-tools).
  python canopen_dcf_crosscheck.py compare CORPUS --lely lely.json --edsdcfnet edsdcfnet.json
         --roundtrip roundtrip.json --exceptions canopen-dcf-crosscheck-exceptions.json
      Compares the verdicts. Exit code 1 when a difference is not listed as an exception.

Rules of the comparison:
  1. Every Lely finding has an editor finding on the same section or object.
  2. Lely's blocking findings (communication area 0x1000-0x1FFF, not about limits only) block in
     the editor too, and a file the editor refuses has a blocking Lely finding.
  3. Every EdsDcfNet error has an editor finding on the same line or section.
  4. An exported DCF has no Lely finding or EdsDcfNet error that the file it came from lacks.
  5. Neither checker fails to read a file.
  6. EdsDcfNet reads the same ParameterValues and [DeviceComissioning] from an exported DCF as the
     editor does (roundtrip.json from .github/scripts/canopen-dcf-roundtrip).
EdsDcfNet follows CiA 306-1 v1.4.0 and the editor v1.3.0; its warnings that the editor has no
finding for are listed as notes, which do not fail the run.
A listed exception names the tool, the file (a glob), the kind of difference, a text the finding contains
and the CiA 306 clause that decides it.
"""

import argparse
import fnmatch
import io
import json
import os
import re
import sys
import warnings
from dataclasses import dataclass, field
from typing import Dict, List, Optional

_SECTION_IN_MESSAGE = re.compile(r"\[([^\]]+)\]")
# Messages that name a section without brackets.
_SECTION_NAMED = re.compile(r"^(?:unknown section in DCF|invalid sub-index): (\S+)$")
_INDEX_IN_MESSAGE = re.compile(r"0x([0-9A-Fa-f]{4})\b")
_OBJECT_SECTION = re.compile(r"^([0-9A-Fa-f]{4})(sub[0-9A-Fa-f]+|value|name|denotation)?$", re.IGNORECASE)
_LISTING = re.compile(
    r"is not mandatory|is manufacturer-specific|is not manufacturer-specific|"
    r"data type objects are not supported"
)
_LIMIT = re.compile(
    r"^(invalid (LowLimit|HighLimit) in|(LowLimit|HighLimit) (overflow|underflow|not supported) in)"
)
_VALUE_RANGE = re.compile(r"^(DefaultValue|ParameterValue) (overflow|underflow) in \[([^\]]+)\]$")
_VALUE = re.compile(r"^(\$NODEID\s*\+\s*)?(-?0x[0-9a-f]+|-?[0-9]+)$", re.IGNORECASE)
_REALS = (0x0008, 0x0011)
_TYPE_RANGE = {
    0x0001: (0, 1),
    0x0002: (-0x80, 0x7F),
    0x0003: (-0x8000, 0x7FFF),
    0x0004: (-0x80000000, 0x7FFFFFFF),
    0x0005: (0, 0xFF),
    0x0006: (0, 0xFFFF),
    0x0007: (0, 0xFFFFFFFF),
    0x0010: (-0x800000, 0x7FFFFF),
    0x0012: (-0x8000000000, 0x7FFFFFFFFF),
    0x0013: (-0x800000000000, 0x7FFFFFFFFFFF),
    0x0014: (-0x80000000000000, 0x7FFFFFFFFFFFFF),
    0x0015: (-0x8000000000000000, 0x7FFFFFFFFFFFFFFF),
    0x0016: (0, 0xFFFFFF),
    0x0018: (0, 0xFFFFFFFFFF),
    0x0019: (0, 0xFFFFFFFFFFFF),
    0x001A: (0, 0xFFFFFFFFFFFFFF),
    0x001B: (0, 0xFFFFFFFFFFFFFFFF),
}
NODE_ID = 2


def _value_inside_type(cfg: Dict[str, Dict[str, str]], section: str, entry: str) -> bool:
    try:
        sec = cfg[section]
        data_type = int(sec["DataType"], 0)
        value = sec[entry].strip()
    except (KeyError, ValueError):
        return False
    if data_type in _REALS:
        return True
    if data_type not in _TYPE_RANGE:
        return False
    if value.upper() == "$NODEID":
        number = NODE_ID
    else:
        m = _VALUE.match(value)
        if not m:
            return False
        try:
            number = int(m.group(2), 0) + (NODE_ID if m.group(1) else 0)
        except ValueError:
            return False
    low, high = _TYPE_RANGE[data_type]
    return low <= number <= high


def classify(cfg: Dict[str, Dict[str, str]], message: str) -> Dict[str, object]:
    """One Lely lint message as {message, section, index, limit_only, blocking}."""
    m = _SECTION_IN_MESSAGE.search(message) or _SECTION_NAMED.match(message)
    section = m.group(1) if m else None
    index = None
    om = _OBJECT_SECTION.match(section or "")
    if om:
        index = int(om.group(1), 16)
    elif section is None:
        im = _INDEX_IN_MESSAGE.search(message)
        if im:
            index = int(im.group(1), 16)
    limit_only = bool(_LIMIT.match(message))
    vm = _VALUE_RANGE.match(message)
    if vm:
        limit_only = _value_inside_type(cfg, vm.group(3), vm.group(1))
    blocking = (
        index is not None
        and 0x1000 <= index <= 0x1FFF
        and not limit_only
        and not _LISTING.search(message)
    )
    return {
        "message": message,
        "section": section,
        "index": index,
        "limit_only": limit_only,
        "blocking": blocking,
    }


def run_lely(corpus: str) -> Dict[str, Dict[str, object]]:
    """{file: {crash} or {ok, findings}} from Lely's lint, reading files as UTF-8."""
    from dcf import parse as lely_parse  # pylint: disable=import-outside-toplevel
    from dcf.lint import lint  # pylint: disable=import-outside-toplevel

    lely_parse.open = lambda path, *a, **k: io.open(path, *a, encoding="utf-8", **k)
    out: Dict[str, Dict[str, object]] = {}
    for name in sorted(_verdicts(corpus)):
        try:
            cfg = lely_parse.parse_file(os.path.join(corpus, name))
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                ok = bool(lint(cfg))
        except Exception as e:  # pylint: disable=broad-exception-caught
            out[name] = {"crash": "%s: %s" % (type(e).__name__, str(e).splitlines()[0])}
            continue
        out[name] = {"ok": ok, "findings": [classify(cfg, str(w.message)) for w in caught]}
    return out


def _verdicts(corpus: str) -> Dict[str, Dict[str, object]]:
    with open(os.path.join(corpus, "verdicts.json"), encoding="utf-8") as f:
        data: Dict[str, Dict[str, object]] = json.load(f)
    return data


@dataclass
class Exception_:
    tool: str
    file: str
    kind: str
    match: str
    clause: str
    reason: str
    used: bool = False


@dataclass
class Report:
    exceptions: List[Exception_]
    failures: List[str] = field(default_factory=list)
    excused: List[str] = field(default_factory=list)

    def differ(self, tool: str, file: str, kind: str, text: str) -> None:
        for e in self.exceptions:
            if e.tool == tool and fnmatch.fnmatchcase(file, e.file) and e.kind == kind and e.match in text:
                e.used = True
                self.excused.append("%s %s %s: %s (%s)" % (tool, file, kind, text, e.clause))
                return
        self.failures.append("%s %s %s: %s" % (tool, file, kind, text))


def _same_place(editor: Dict[str, object], section: Optional[str], index: Optional[int]) -> bool:
    es = editor.get("section")
    if section is not None and isinstance(es, str) and es.upper() == section.upper():
        return True
    return index is not None and editor.get("index") == index


def _editor_findings(verdict: Dict[str, object]) -> List[Dict[str, object]]:
    findings = verdict.get("findings")
    return [f for f in findings if isinstance(f, dict)] if isinstance(findings, list) else []


def _lely_keys(result: Dict[str, object]) -> List[str]:
    findings = result.get("findings")
    if not isinstance(findings, list):
        return []
    return [str(f.get("message")) for f in findings if isinstance(f, dict)]


def compare_lely(
    report: Report, verdicts: Dict[str, Dict[str, object]], lely: Dict[str, Dict[str, object]]
) -> None:
    for name, verdict in sorted(verdicts.items()):
        result = lely.get(name)
        if result is None:
            report.failures.append("lely %s: not checked" % name)
            continue
        if "crash" in result:
            report.differ("lely", name, "crash", str(result["crash"]))
            continue
        editor = _editor_findings(verdict)
        findings = result.get("findings")
        lely_findings = [f for f in findings if isinstance(f, dict)] if isinstance(findings, list) else []
        for f in lely_findings:
            section = f.get("section") if isinstance(f.get("section"), str) else None
            index = f.get("index") if isinstance(f.get("index"), int) else None
            if not any(_same_place(e, section, index) for e in editor):
                report.differ("lely", name, "finding", str(f.get("message")))
        lely_blocks = any(f.get("blocking") for f in lely_findings)
        editor_blocks = not verdict.get("ok")
        if verdict.get("kind") == "eds" and lely_blocks != editor_blocks:
            what = [str(f.get("message")) for f in lely_findings if f.get("blocking")]
            report.differ(
                "lely",
                name,
                "blocking",
                "Lely %s, the editor %s: %s"
                % (
                    "blocks" if lely_blocks else "does not block",
                    "blocks" if editor_blocks else "does not block",
                    "; ".join(what) or "no blocking Lely finding",
                ),
            )
        source = verdict.get("source")
        if verdict.get("kind") == "export" and isinstance(source, str):
            before = set(_lely_keys(lely.get(source, {})))
            for message in _lely_keys(result):
                if message not in before:
                    report.differ("lely", name, "export", message)


def _net_errors(entry: Dict[str, object]) -> List[Dict[str, object]]:
    findings = entry.get("findings")
    if not isinstance(findings, list):
        return []
    return [f for f in findings if isinstance(f, dict) and f.get("severity") == "error"]


def compare_edsdcfnet(
    report: Report, verdicts: Dict[str, Dict[str, object]], net: List[Dict[str, object]]
) -> None:
    by_file = {os.path.basename(str(e.get("file"))): e for e in net if isinstance(e, dict)}
    for name, verdict in sorted(verdicts.items()):
        entry = by_file.get(name)
        if entry is None:
            report.differ("edsdcfnet", name, "crash", "not checked")
            continue
        editor = _editor_findings(verdict)
        for f in _net_errors(entry):
            line, section = f.get("line"), f.get("section")
            text = "%s [%s] %s line %s: %s" % (f.get("code"), section, f.get("key"), line, f.get("message"))
            matched = any(
                (isinstance(line, int) and e.get("line") == line)
                or (isinstance(section, str) and _same_place(e, section, None))
                for e in editor
            )
            if not matched:
                report.differ("edsdcfnet", name, "finding", text)
        source = verdict.get("source")
        if verdict.get("kind") == "export" and isinstance(source, str):
            before = {(f.get("code"), str(f.get("section")).upper()) for f in _net_errors(by_file.get(source, {}))}
            for f in _net_errors(entry):
                if (f.get("code"), str(f.get("section")).upper()) not in before:
                    report.differ(
                        "edsdcfnet", name, "export", "%s [%s]: %s" % (f.get("code"), f.get("section"), f.get("message"))
                    )


def _same_value(a: str, b: str) -> bool:
    if a.strip() == b.strip():
        return True
    for parse in (lambda t: int(t, 0), float):
        try:
            return parse(a.strip()) == parse(b.strip())
        except ValueError:
            continue
    return False


def compare_roundtrip(
    report: Report, verdicts: Dict[str, Dict[str, object]], roundtrip: List[Dict[str, object]]
) -> None:
    by_file = {str(e.get("file")): e for e in roundtrip if isinstance(e, dict)}
    for name, verdict in sorted(verdicts.items()):
        if verdict.get("kind") != "export":
            continue
        entry = by_file.get(name)
        if entry is None or "error" in entry:
            report.differ("roundtrip", name, "crash", str((entry or {}).get("error", "not read")))
            continue
        mine = verdict.get("values") if isinstance(verdict.get("values"), dict) else {}
        theirs = entry.get("values") if isinstance(entry.get("values"), dict) else {}
        for key in sorted(set(mine) | set(theirs)):
            a, b = mine.get(key), theirs.get(key)
            if a is None or b is None or not _same_value(str(a), str(b)):
                report.differ("roundtrip", name, "value", "%s: editor %s, EdsDcfNet %s" % (key, a, b))
        c = verdict.get("commissioning") if isinstance(verdict.get("commissioning"), dict) else {}
        t = entry.get("commissioning") if isinstance(entry.get("commissioning"), dict) else {}
        for mine_key, their_key in (("nodeId", "nodeId"), ("nodeName", "nodeName"), ("baudrateKbit", "baudrate")):
            if c.get(mine_key, 0 if mine_key != "nodeName" else "") != t.get(their_key):
                report.differ(
                    "roundtrip",
                    name,
                    "value",
                    "[DeviceComissioning] %s: editor %s, EdsDcfNet %s" % (mine_key, c.get(mine_key), t.get(their_key)),
                )


def edsdcfnet_notes(verdicts: Dict[str, Dict[str, object]], net: List[Dict[str, object]]) -> List[str]:
    """EdsDcfNet warnings with no editor finding on the same line or section."""
    notes: List[str] = []
    by_file = {os.path.basename(str(e.get("file"))): e for e in net if isinstance(e, dict)}
    for name, verdict in sorted(verdicts.items()):
        editor = _editor_findings(verdict)
        findings = by_file.get(name, {}).get("findings")
        for f in findings if isinstance(findings, list) else []:
            if not isinstance(f, dict) or f.get("severity") != "warning":
                continue
            line, section = f.get("line"), f.get("section")
            if any(
                (isinstance(line, int) and e.get("line") == line)
                or (isinstance(section, str) and _same_place(e, section, None))
                for e in editor
            ):
                continue
            notes.append("%s %s [%s] %s: %s" % (name, f.get("code"), section, f.get("key"), f.get("message")))
    return notes


def _load_exceptions(path: str) -> List[Exception_]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    entries = data.get("exceptions", []) if isinstance(data, dict) else []
    return [
        Exception_(
            tool=str(e["tool"]),
            file=str(e["file"]),
            kind=str(e["kind"]),
            match=str(e["match"]),
            clause=str(e["clause"]),
            reason=str(e["reason"]),
        )
        for e in entries
    ]


def compare(args: argparse.Namespace) -> int:
    verdicts = _verdicts(args.corpus)
    report = Report(_load_exceptions(args.exceptions))
    if args.lely:
        with open(args.lely, encoding="utf-8") as f:
            compare_lely(report, verdicts, json.load(f))
    notes: List[str] = []
    if args.edsdcfnet:
        with open(args.edsdcfnet, encoding="utf-8") as f:
            net = json.load(f)
        compare_edsdcfnet(report, verdicts, net)
        notes = edsdcfnet_notes(verdicts, net)
    if args.roundtrip:
        with open(args.roundtrip, encoding="utf-8") as f:
            compare_roundtrip(report, verdicts, json.load(f))
    tools = {
        t for t, on in (("lely", args.lely), ("edsdcfnet", args.edsdcfnet), ("roundtrip", args.roundtrip)) if on
    }
    stale = [e for e in report.exceptions if not e.used and e.tool in tools]
    lines = ["## CANopen DCF cross-check", "", "%d files checked." % len(verdicts), ""]
    if report.failures:
        lines += ["### Differences", ""] + ["- %s" % f for f in report.failures] + [""]
    if report.excused:
        lines += ["### Listed exceptions", ""] + ["- %s" % f for f in report.excused] + [""]
    if notes:
        lines += ["### Notes from EdsDcfNet (CiA 306-1 v1.4.0 warnings without an editor finding)", ""]
        lines += ["- %s" % n for n in notes] + [""]
    if stale:
        lines += ["### Exceptions not used", ""]
        lines += ["- %s %s %s: %s" % (e.tool, e.file, e.kind, e.match) for e in stale] + [""]
    text = "\n".join(lines)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    return 1 if report.failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    lely = sub.add_parser("lely")
    lely.add_argument("corpus")
    cmp_ = sub.add_parser("compare")
    cmp_.add_argument("corpus")
    cmp_.add_argument("--lely")
    cmp_.add_argument("--edsdcfnet")
    cmp_.add_argument("--roundtrip")
    cmp_.add_argument("--exceptions", required=True)
    args = parser.parse_args()
    if args.command == "lely":
        json.dump(run_lely(args.corpus), sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    return compare(args)


if __name__ == "__main__":
    sys.exit(main())

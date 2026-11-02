"""Cross-checks the DBC files the CANopen editor exports.

Loads each DBC of the corpus (written by __tests__/dbc-crosscheck-writer.test.ts) with cantools in
strict mode and with canmatrix, within a load-time limit, decodes the frames listed in expected.json,
decodes every SDO command byte in both directions, and decodes real SDO transfers that python-canopen
makes between a client and a server on a virtual bus.

Usage: canopen_dbc_crosscheck.py <corpus> [--max-load-seconds N]
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import can
import canmatrix.formats
import canopen
import cantools
from cantools.database.can import Database

# CANopen data types with a fixed size of at most 32 bits: (struct format, bytes).
TYPES = {
    0x01: ("<B", 1),
    0x02: ("<b", 1),
    0x03: ("<h", 2),
    0x04: ("<i", 4),
    0x05: ("<B", 1),
    0x06: ("<H", 2),
    0x07: ("<I", 4),
    0x08: ("<f", 4),
}


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def fail(self, text: str) -> None:
        self.errors.append(text)
        print(f"ERROR {text}")

    def note(self, text: str) -> None:
        self.notes.append(text)
        print(text)


def load(path: Path, max_seconds: float, report: Report) -> Database | None:
    start = time.monotonic()
    try:
        db = cantools.database.load_file(str(path), strict=True)
    except Exception as error:  # noqa: BLE001 - any load failure is a finding
        report.fail(f"{path.name}: cantools strict load failed: {error}")
        return None
    seconds = time.monotonic() - start
    if not isinstance(db, Database):
        report.fail(f"{path.name}: cantools did not read a CAN database")
        return None
    report.note(f"{path.name}: cantools strict load {seconds:.1f} s, {len(db.messages)} messages")
    if seconds > max_seconds:
        report.fail(f"{path.name}: cantools load took {seconds:.1f} s, more than {max_seconds} s")
    start = time.monotonic()
    try:
        matrix = canmatrix.formats.loadp_flat(str(path))
    except Exception as error:  # noqa: BLE001
        report.fail(f"{path.name}: canmatrix load failed: {error}")
        return db
    report.note(f"{path.name}: canmatrix load {time.monotonic() - start:.1f} s")
    if len(matrix.frames) != len(db.messages):
        report.fail(f"{path.name}: canmatrix reads {len(matrix.frames)} frames, cantools {len(db.messages)}")
    return db


def decode(db: Database, frame_id: int, data: bytes, **kwargs: bool) -> dict[str, object]:
    return dict(db.decode_message(frame_id, data, **kwargs))


def check_frames(db: Database, name: str, frames: list[dict[str, object]], report: Report) -> None:
    for frame in frames:
        if frame["file"] != name:
            continue
        frame_id = int(str(frame["id"]))
        hex_data = str(frame["data"])
        data = bytes.fromhex(hex_data.replace(" ", ""))
        try:
            values = decode(db, frame_id, data)
        except Exception as error:  # noqa: BLE001
            report.fail(f"{name}: 0x{frame_id:03X} [{hex_data}] does not decode: {error}")
            continue
        expected = frame["signals"]
        if not isinstance(expected, dict):
            continue
        for signal, want in expected.items():
            got = values.get(signal)
            got_value = str(got) if isinstance(want, str) else got
            if isinstance(want, float) and isinstance(got, (int, float)):
                ok = abs(got - want) < 1e-6
            else:
                ok = got_value == want
            if not ok:
                report.fail(f"{name}: 0x{frame_id:03X} [{hex_data}] {signal} = {got!r}, expected {want!r}")
    report.note(f"{name}: expected frames checked")


def check_command_bytes(db: Database, name: str, node_id: int, report: Report) -> None:
    count = 0
    for frame_id in (0x600 + node_id, 0x580 + node_id):
        for command in range(256):
            for obj in (b"\x17\x10\x00", b"\x00\x50\x00", b"\x00\x10\x07", b"\x01\x64\x01"):
                data = bytes([command]) + obj + b"\x01\x02\x03\x04"
                try:
                    decode(db, frame_id, data)
                    count += 1
                except Exception as error:  # noqa: BLE001
                    report.fail(f"{name}: 0x{frame_id:03X} [{data.hex(' ')}] does not decode: {error}")
    report.note(f"{name}: node {node_id}, {count} SDO frames of every command byte decode")


def object_comment(db: Database, frame_id: int, index: int, sub: int) -> set[str]:
    prefix = f"0x{index:04X}:{sub} "
    return {s.name for s in db.get_message_by_frame_id(frame_id).signals if (s.comment or "").startswith(prefix)}


def sdo_traffic(eds: Path, node_id: int) -> tuple[list[can.Message], list[tuple[int, int, int, bytes]]]:
    """Runs uploads and downloads of every small typed object, a segmented transfer and aborts."""
    channel = f"sdo{node_id}"
    server, client = canopen.Network(), canopen.Network()
    server.connect(interface="virtual", channel=channel)
    client.connect(interface="virtual", channel=channel)
    spy = can.Bus(interface="virtual", channel=channel)
    od = canopen.import_od(str(eds), node_id)
    server.add_node(canopen.LocalNode(node_id, od))
    remote = client.add_node(node_id, str(eds))
    remote.sdo.RESPONSE_TIMEOUT = 1
    expedited: list[tuple[int, int, int, bytes]] = []
    variables = []
    for obj in od.values():
        if isinstance(obj, canopen.objectdictionary.ODVariable):
            variables.append(obj)
        else:
            variables.extend(obj.values())
    for var in variables:
        kind = TYPES.get(var.data_type)
        if kind is None:
            continue
        fmt, size = kind
        try:
            if "w" in var.access_type:
                # A heartbeat producer time of 1 ms would flood the bus: write 0 (off) there.
                number = 0 if var.index == 0x1017 else 1
                value = struct.pack(fmt, 1.5 if fmt == "<f" else number)
                remote.sdo.download(var.index, var.subindex, value)
                expedited.append((0x600 + node_id, var.index, var.subindex, value))
            if "r" in var.access_type:
                value = remote.sdo.upload(var.index, var.subindex)
                expedited.append((0x580 + node_id, var.index, var.subindex, value[:size]))
        except canopen.SdoAbortedError:
            pass
    for action in (
        lambda: remote.sdo.upload(0x1008, 0),
        lambda: remote.sdo.download(0x2100, 0, b"\x44\x33\x22\x11", force_segment=True),
        lambda: remote.sdo.upload(0x5000, 0),
        lambda: remote.sdo.download(0x1000, 0, b"\x00\x00\x00\x00"),
    ):
        try:
            action()
        except (canopen.SdoAbortedError, canopen.SdoCommunicationError):
            pass
    time.sleep(0.2)
    frames = []
    while (msg := spy.recv(0.05)) is not None:
        if msg.arbitration_id in (0x600 + node_id, 0x580 + node_id):
            frames.append(msg)
    for bus in (server, client):
        bus.disconnect()
    spy.shutdown()
    return frames, expedited


def check_sdo(
    db: Database, name: str, eds: Path, node: dict[str, object], report: Report
) -> None:
    node_id = int(str(node["nodeId"]))
    frames, expedited = sdo_traffic(eds, node_id)
    for msg in frames:
        try:
            decode(db, msg.arbitration_id, bytes(msg.data))
        except Exception as error:  # noqa: BLE001
            report.fail(f"{name}: SDO 0x{msg.arbitration_id:03X} [{bytes(msg.data).hex(' ')}]: {error}")
    typed = 0
    if node["typed"]:
        for frame_id, index, sub, value in expedited:
            names = object_comment(db, frame_id, index, sub)
            command = (0x23 if frame_id >= 0x600 else 0x43) | ((4 - len(value)) << 2)
            data = bytes([command, index & 0xFF, index >> 8, sub]) + value.ljust(4, b"\x00")
            values = decode(db, frame_id, data, scaling=False, decode_choices=False)
            hit = [n for n in names if n in values]
            if not hit:
                report.fail(f"{name}: 0x{frame_id:03X} 0x{index:04X}:{sub} has no typed value signal")
                continue
            raw = values[hit[0]]
            fmt = next(f for f, size in TYPES.values() if size == len(value))
            want = [struct.unpack(f, value)[0] for f, size in TYPES.values() if size == len(value)]
            if not any(raw == w or (isinstance(w, float) and abs(float(raw) - w) < 1e-6) for w in want):
                report.fail(f"{name}: 0x{index:04X}:{sub} decodes to {raw!r}, sent {value.hex(' ')} ({fmt})")
            typed += 1
    report.note(
        f"{name}: node {node_id}, {len(frames)} SDO frames from python-canopen decode, {typed} typed values match"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path)
    parser.add_argument("--max-load-seconds", type=float, default=60.0)
    args = parser.parse_args()
    corpus: Path = args.corpus
    expected = json.loads((corpus / "expected.json").read_text())
    eds = corpus / "generic-io-module.eds"
    report = Report()
    for name, info in expected["files"].items():
        db = load(corpus / name, args.max_load_seconds, report)
        if db is None:
            continue
        if len(db.messages) != info["messages"]:
            report.fail(f"{name}: {len(db.messages)} messages, the editor wrote {info['messages']}")
        check_frames(db, name, expected["frames"], report)
        for node in info["sdoNodes"]:
            check_command_bytes(db, name, int(node["nodeId"]), report)
            check_sdo(db, name, eds, node, report)
    print(f"{len(report.errors)} errors")
    return 1 if report.errors else 0


if __name__ == "__main__":
    sys.exit(main())

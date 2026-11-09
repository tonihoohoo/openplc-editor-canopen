#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Check that compressed macOS disk images (UDIF .dmg) are intact.

  check_dmg.py FILE.dmg [FILE.dmg ...]

For each image: the 512-byte ``koly`` trailer ends the file, the data fork's
CRC32 matches the checksum in the trailer, and every compressed chunk listed
in the block map decompresses to its stated size. Exits non-zero, naming each
damaged image, when any check fails. Runs on any OS, so the publish job can
check the images it is about to release without macOS.
"""

from __future__ import annotations

import binascii
import bz2
import lzma
import plistlib
import struct
import sys
import zlib

SECTOR = 512
CHUNK_DECODERS = {
    0x80000005: zlib.decompress,
    0x80000006: bz2.decompress,
    0x80000008: lzma.decompress,
}
CHUNK_RAW = 0x00000001
CHECKSUM_CRC32 = 2


def check(data: bytes) -> list[str]:
    """Every problem found in one image; empty when it is intact."""
    if len(data) < SECTOR or data[-SECTOR:][:4] != b"koly":
        return ["no UDIF trailer at the end of the file (truncated or not a .dmg)"]
    trailer = data[-SECTOR:]
    fork_off, fork_len = struct.unpack(">QQ", trailer[24:40])
    xml_off, xml_len = struct.unpack(">QQ", trailer[216:232])
    sum_type, sum_bits = struct.unpack(">II", trailer[80:88])
    problems: list[str] = []
    if fork_off + fork_len > len(data) - SECTOR or xml_off + xml_len > len(data) - SECTOR:
        return ["the trailer points past the end of the file"]
    if sum_type == CHECKSUM_CRC32 and sum_bits == 32:
        want = trailer[88:92]
        got = struct.pack(">I", binascii.crc32(data[fork_off : fork_off + fork_len]) & 0xFFFFFFFF)
        if want != got:
            problems.append(f"data checksum {got.hex()} differs from the trailer's {want.hex()}")
    try:
        blocks = plistlib.loads(data[xml_off : xml_off + xml_len])["resource-fork"]["blkx"]
    except (plistlib.InvalidFileException, KeyError, ValueError) as error:
        return problems + [f"unreadable block map: {error}"]
    bad = 0
    total = 0
    for block in blocks:
        table = block["Data"]
        count = struct.unpack(">I", table[200:204])[0]
        for i in range(count):
            kind, _, _, sectors, off, length = struct.unpack(">IIQQQQ", table[204 + 40 * i : 244 + 40 * i])
            chunk = data[fork_off + off : fork_off + off + length]
            decode = CHUNK_DECODERS.get(kind)
            if decode is None:
                if kind == CHUNK_RAW and len(chunk) != sectors * SECTOR:
                    bad += 1
                total += kind == CHUNK_RAW
                continue
            total += 1
            try:
                if len(decode(chunk)) != sectors * SECTOR:
                    bad += 1
            except (zlib.error, OSError, lzma.LZMAError, ValueError):
                bad += 1
    if bad:
        problems.append(f"{bad} of {total} data chunks are damaged")
    return problems


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    failed = 0
    for path in argv:
        with open(path, "rb") as handle:
            problems = check(handle.read())
        if problems:
            failed += 1
            for problem in problems:
                print(f"::error::{path}: {problem}")
        else:
            print(f"{path}: intact")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

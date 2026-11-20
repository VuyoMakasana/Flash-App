#!/usr/bin/env python3
"""Statement-level deltas between normalized schemas (docs/PROD_MIGRATIONS.md s4).

Reads files only; never connects to anything. Runs in the python container
(steps C and D) or on a developer machine.

Input files are in `normalize_schema.py --baseline` form: statements separated
by one blank line, sorted.

Why deltas: restoring a dump into a new database and dumping it again can
re-spell some expressions (Postgres deparses a restored CHECK
`= ANY ((ARRAY[...])::text[])` as `= ANY (ARRAY[(...)::text, ...])`). So a
local copy of production is never byte-identical to production, but the
CHANGE a migration makes is. Every check that involves a local copy compares
changes, never absolute fingerprints.

Usage:
  schema_delta.py show OLD NEW              print removed (-) / added (+) statements
  schema_delta.py same-delta A0 A1 B0 B1    exit 0 iff A0->A1 makes exactly the change B0->B1
  schema_delta.py apply BASE A0 A1          print BASE with the change A0->A1 applied
  schema_delta.py equal X Y                 exit 0 iff X and Y hold the same statements
"""
import sys


def stmts(path):
    text = open(path, encoding="utf-8").read()
    out = [s for s in text.split("\n\n") if s.strip()]
    return [s.rstrip("\n") for s in out]


def delta(old, new):
    o, n = set(stmts(old)), set(stmts(new))
    return o - n, n - o


def show(old, new):
    removed, added = delta(old, new)
    for s in sorted(removed):
        print("- " + s.replace("\n", "\n  "))
    for s in sorted(added):
        print("+ " + s.replace("\n", "\n  "))
    print(f"removed={len(removed)} added={len(added)}")
    return 0


def same_delta(a0, a1, b0, b1):
    ar, aa = delta(a0, a1)
    br, ba = delta(b0, b1)
    ok = (ar, aa) == (br, ba)
    print(f"local change: removed={len(ar)} added={len(aa)} | expected change: removed={len(br)} added={len(ba)} | {'SAME' if ok else 'DIFFERENT'}")
    if not ok:
        for s in sorted(aa ^ ba):
            print("  added-mismatch: " + s.split("\n")[0])
        for s in sorted(ar ^ br):
            print("  removed-mismatch: " + s.split("\n")[0])
    return 0 if (ok and (aa or ar)) else 1


def apply(base, a0, a1):
    removed, added = delta(a0, a1)
    b = set(stmts(base))
    missing = [s for s in removed if s not in b]
    present = [s for s in added if s in b]
    if missing or present:
        for s in missing:
            print("removed statement not in BASE: " + s.split("\n")[0], file=sys.stderr)
        for s in present:
            print("added statement already in BASE: " + s.split("\n")[0], file=sys.stderr)
        return 1
    result = (b - removed) | added
    sys.stdout.buffer.write(("\n\n".join(sorted(result)) + "\n").encode("utf-8"))
    return 0


def equal(x, y):
    ok = set(stmts(x)) == set(stmts(y))
    print("SAME" if ok else "DIFFERENT")
    return 0 if ok else 1


def main(argv):
    cmd, args = (argv[1], argv[2:]) if len(argv) > 1 else (None, [])
    if cmd == "show" and len(args) == 2:
        return show(*args)
    if cmd == "same-delta" and len(args) == 4:
        return same_delta(*args)
    if cmd == "apply" and len(args) == 3:
        return apply(*args)
    if cmd == "equal" and len(args) == 2:
        return equal(*args)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

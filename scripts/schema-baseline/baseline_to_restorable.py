#!/usr/bin/env python3
"""Turn the committed baseline back into a restorable SQL script (dev tool).

Developer-only (never run by the founder, never connects to anything): it
reads production_schema_baseline.sql and prints its statements in dependency
order, so a throwaway LOCAL database can be built whose schema is
production's. docs/PROD_MIGRATIONS.md s4 uses it to compute a new migration's
AFTER fingerprint:

  baseline -> this script -> local DB (prod shape) -> apply vNN with psql
  -> pg_dump (prod_dump_schema.sh flags) -> normalize_schema.py --baseline
  -> sha256 = AFTER

The round trip is checked, not assumed: the local DB's own dump must
normalize back to the input baseline byte for byte (sha256 printed by the
proof), or the fixture is not production's shape.

The baseline is sorted (normalize_schema.py --baseline); restore order is:
  0 CREATE SCHEMA   1 COMMENT ON SCHEMA   2 CREATE TYPE / FUNCTION / SEQUENCE
  3 CREATE TABLE    4 PRIMARY KEY / UNIQUE / CHECK / EXCLUDE constraints
  5 CREATE [UNIQUE] INDEX   6 FOREIGN KEY constraints   7 anything else
Unknown statement kinds are rank 7 and listed on stderr, so nothing is
silently reordered wrongly.

Usage: baseline_to_restorable.py BASELINE.sql > restorable.sql
"""
import re
import sys


def rank(stmt):
    lines = stmt.split("\n")
    first = lines[0]
    second = lines[1].strip() if len(lines) > 1 else ""
    if first.startswith("CREATE SCHEMA "):
        return 0
    if first.startswith("COMMENT ON SCHEMA "):
        return 1
    if re.match(r"^CREATE (TYPE|FUNCTION|OR REPLACE FUNCTION|SEQUENCE) ", first):
        return 2
    if first.startswith("CREATE TABLE "):
        return 3
    if first.startswith("ALTER TABLE ONLY ") and re.match(r"^ADD CONSTRAINT \S+ (PRIMARY KEY|UNIQUE|CHECK|EXCLUDE)\b", second):
        return 4
    if re.match(r"^CREATE (UNIQUE )?INDEX ", first):
        return 5
    if first.startswith("ALTER TABLE ONLY ") and re.match(r"^ADD CONSTRAINT \S+ FOREIGN KEY\b", second):
        return 6
    print("rank 7 (unclassified): " + first, file=sys.stderr)
    return 7


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    text = open(argv[1], encoding="utf-8").read()
    stmts = [s for s in text.split("\n\n") if s.strip()]
    ordered = sorted(enumerate(stmts), key=lambda p: (rank(p[1]), p[0]))
    sys.stdout.buffer.write(("\n\n".join(s for _, s in ordered) + "\n").encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

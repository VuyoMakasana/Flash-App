#!/usr/bin/env python3
"""Normalize and compare `pg_dump --schema-only` files (docs/SCHEMA_BASELINE.md).

Never connects to anything; reads dump files only.

Normalization steps (every one is listed so the diff can be trusted):
  N1  Drop SQL comment lines (`-- ...`).
  N2  Drop psql meta-commands `\\restrict` / `\\unrestrict` (pg_dump >= 17.6
      writes a random nonce per dump).
  N3  Drop session-setup lines: `SET ...;` and `SELECT pg_catalog.set_config(...)`.
  N4  Drop blank lines and trailing whitespace.
  N5  Split into statements on a line ending with `;`.
  N6  Inside each CREATE TABLE, sort the column/constraint lines (trailing
      commas stripped). Each line still carries the column's full definition
      (type, collation, default, nullability), so only POSITION is ignored.
      Position itself is checked separately (column-order check below).
  N7  Sort the statements.
  N8  NARROW CHECK-spelling rule. Only for the constraint names listed in
      ACCEPTED_CHECK_SPELLING, rewrite the spelling Postgres prints for a
      fresh `col IN ('a', 'b')`:
          ((col)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))
      into the spelling production prints for the same constraint:
          ((col)::text = ANY (ARRAY[('a'::character varying)::text, ('b'::character varying)::text]))
      The column name and every value are carried through unchanged, so a
      different column, a different value list, or a constraint not on the
      list still shows up as a difference. --self-test proves this.

Comparison (--compare FRESH PROD) fails on ANY difference except:
  - statements whose OWN table is a production-only settlement table
    (ACCEPTED_PROD_ONLY_TABLES); a statement on any other table that merely
    references one is NOT accepted;
  - column POSITION in ACCEPTED_COLUMN_ORDER tables (column set and each
    column's full definition must still match).

Usage:
  normalize_schema.py DUMP.sql                  normalized statements to stdout
  normalize_schema.py --column-order DUMP.sql   "table: col1,col2,..." lines
  normalize_schema.py --compare FRESH PROD      exit 0 only if no unaccepted diff
  normalize_schema.py --self-test               exit 0 only if N8 and the prod-only rule stay narrow
  normalize_schema.py --stats DUMP.sql          "bytes=N create_tables=M"
  normalize_schema.py --baseline DUMP.sql       committable baseline (order-preserving) to stdout
"""
import re
import sys

# 16 constraints on 12 tables; semantic equivalence tested in SCHEMA_BASELINE.md §4.4.
ACCEPTED_CHECK_SPELLING = frozenset({
    "chat_reports_reported_role_check",
    "chat_reports_reporter_role_check",
    "chat_reports_status_check",
    "commission_rates_scope_store_check",
    "commission_rates_scope_type_check",
    "driver_commission_debts_status_check",
    "email_tokens_type_check",
    "marketing_applications_applicant_type_check",
    "marketing_waitlist_role_check",
    "messages_sender_role_check",
    "sos_alerts_triggered_by_role_check",
    "store_users_role_check",
    "stores_status_check",
    "trusted_drivers_status_check",
    "user_blocks_blocked_role_check",
    "user_blocks_blocker_role_check",
})

ACCEPTED_COLUMN_ORDER = frozenset({"public.orders", "public.stores"})

ACCEPTED_PROD_ONLY_TABLES = ("settlement_config", "store_settlements", "store_settlement_line_items")

_FRESH_ANY = re.compile(
    r"\(\((\w+)\)::text = ANY \(\(ARRAY\[((?:'[^']*'::character varying(?:, )?)+)\]\)::text\[\]\)\)"
)


def _n8_rewrite_expr(expr):
    def repl(m):
        col, values = m.group(1), re.findall(r"'[^']*'::character varying", m.group(2))
        return f"(({col})::text = ANY (ARRAY[" + ", ".join(f"({v})::text" for v in values) + "]))"
    return _FRESH_ANY.sub(repl, expr)


def n8(line):
    m = re.match(r"^(\s*CONSTRAINT )(\S+)( CHECK .*)$", line)
    if not m or m.group(2) not in ACCEPTED_CHECK_SPELLING:
        return line
    return m.group(1) + m.group(2) + _n8_rewrite_expr(m.group(3))


def read_statements(path):
    lines = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip()
            s = line.strip()
            if not s or s.startswith("--"):
                continue
            if s.startswith("\\restrict") or s.startswith("\\unrestrict"):
                continue
            if re.match(r"^SET\s", s) or s.startswith("SELECT pg_catalog.set_config("):
                continue
            lines.append(n8(line))
    statements, cur = [], []
    for line in lines:
        cur.append(line)
        if line.rstrip().endswith(";"):
            statements.append(cur)
            cur = []
    if cur:
        statements.append(cur)
    return statements


def _is_create_table(stmt):
    return re.match(r"^CREATE TABLE \S+ \($", stmt[0].strip()) and len(stmt) > 2


def normalized(statements):
    out = []
    for stmt in statements:
        if _is_create_table(stmt):
            items = sorted(x.strip().rstrip(",") for x in stmt[1:-1])
            out.append("\n".join([stmt[0].strip()] + ["    " + i for i in items] + [stmt[-1].strip()]))
        else:
            out.append("\n".join(x.strip() for x in stmt))
    return sorted(out)


def column_order(statements):
    out = {}
    for stmt in statements:
        m = re.match(r"^CREATE TABLE (\S+) \($", stmt[0].strip())
        if not m:
            continue
        out[m.group(1)] = [x.strip().split()[0] for x in stmt[1:-1] if not x.strip().startswith("CONSTRAINT ")]
    return out


def _own_table(stmt):
    """The table a statement belongs to (not any table it merely references)."""
    first = stmt.split("\n")[0]
    for pat in (r"^CREATE TABLE public\.(\w+) \(",
                r"^ALTER TABLE ONLY public\.(\w+)$",
                r"^ALTER TABLE public\.(\w+)\b",
                r"^CREATE (?:UNIQUE )?INDEX \S+ ON public\.(\w+) "):
        m = re.match(pat, first)
        if m:
            return m.group(1)
    return None


def _belongs_to_accepted_prod_only(stmt):
    # Matches on the statement's OWN table only, so e.g. a future production-only
    # FK on `orders` that references a settlement table is NOT accepted.
    return _own_table(stmt) in ACCEPTED_PROD_ONLY_TABLES


def compare(fresh_path, prod_path, out=sys.stdout):
    fs, ps = read_statements(fresh_path), read_statements(prod_path)
    f, p = set(normalized(fs)), set(normalized(ps))
    failures = []
    for s in sorted(f - p):
        failures.append("ONLY IN FRESH (or differs):\n" + s)
    for s in sorted(p - f):
        if not _belongs_to_accepted_prod_only(s):
            failures.append("ONLY IN PROD (or differs):\n" + s)
    fo, po = column_order(fs), column_order(ps)
    for t in sorted(set(fo) & set(po)):
        if fo[t] != po[t] and t not in ACCEPTED_COLUMN_ORDER:
            failures.append(f"COLUMN ORDER differs on {t} (not an accepted table)")
    accepted_order = sorted(t for t in set(fo) & set(po) if fo[t] != po[t] and t in ACCEPTED_COLUMN_ORDER)
    accepted_prod = sorted(s.split("\n")[0] for s in (p - f) if _belongs_to_accepted_prod_only(s))
    print(f"accepted: column order on {accepted_order}", file=out)
    print(f"accepted: {len(accepted_prod)} production-only statements for {list(ACCEPTED_PROD_ONLY_TABLES)}", file=out)
    for x in failures:
        print("\nFAIL " + x, file=out)
    print(f"\nRESULT: {'PASS' if not failures else 'FAIL'} ({len(failures)} unaccepted difference(s))", file=out)
    return 0 if not failures else 1


def self_test():
    fresh = "    CONSTRAINT messages_sender_role_check CHECK (((sender_role)::text = ANY ((ARRAY['user'::character varying, 'driver'::character varying])::text[])))"
    prod = "    CONSTRAINT messages_sender_role_check CHECK (((sender_role)::text = ANY (ARRAY[('user'::character varying)::text, ('driver'::character varying)::text])))"
    cases = [
        ("same column + same values normalize equal", n8(fresh) == n8(prod), True),
        ("changed value list stays different",
         n8(fresh.replace("'driver'", "'admin'")) == n8(prod), False),
        ("extra value stays different",
         n8(fresh.replace("'driver'::character varying]", "'driver'::character varying, 'admin'::character varying]")) == n8(prod), False),
        ("different column stays different",
         n8(fresh.replace("(sender_role)", "(other_role)")) == n8(prod), False),
        ("constraint not on the accepted list is not rewritten",
         n8(fresh.replace("messages_sender_role_check", "messages_new_check")) == fresh.replace("messages_sender_role_check", "messages_new_check"), True),
        ("prod spelling is left untouched", n8(prod) == prod, True),
        ("settlement-table statement is accepted as prod-only",
         _belongs_to_accepted_prod_only("ALTER TABLE ONLY public.store_settlements\nADD CONSTRAINT store_settlements_pkey PRIMARY KEY (id);"), True),
        ("an FK on another table that REFERENCES a settlement table is NOT accepted",
         _belongs_to_accepted_prod_only("ALTER TABLE ONLY public.orders\nADD CONSTRAINT x FOREIGN KEY (a) REFERENCES public.store_settlements(id);"), False),
        ("an index ON another table is NOT accepted",
         _belongs_to_accepted_prod_only("CREATE INDEX i ON public.orders USING btree (store_settlement_id);"), False),
    ]
    ok = True
    for name, got, want in cases:
        passed = got == want
        ok &= passed
        print(f"{'PASS' if passed else 'FAIL'}: {name}")
    print("SELF-TEST", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def stats(path):
    """Size and CREATE TABLE count, so 'identical because empty' can never pass."""
    import os
    text = open(path, encoding="utf-8").read()
    return os.path.getsize(path), len(re.findall(r"^CREATE TABLE ", text, re.M))


def baseline(path):
    """Committable form of a production dump: N1-N5 and N7 only (comments, nonce
    lines and session SETs removed; statements sorted). Column ORDER inside each
    CREATE TABLE is kept, so --compare can still check positions against it."""
    return "\n\n".join(sorted("\n".join(stmt) for stmt in read_statements(path))) + "\n"


def main(argv):
    if argv[1:] == ["--self-test"]:
        return self_test()
    if len(argv) == 3 and argv[1] == "--stats":
        size, tables = stats(argv[2])
        print(f"bytes={size} create_tables={tables}")
        return 0
    if len(argv) == 3 and argv[1] == "--baseline":
        sys.stdout.buffer.write(baseline(argv[2]).encode("utf-8"))  # LF on every OS
        return 0
    if len(argv) == 4 and argv[1] == "--compare":
        return compare(argv[2], argv[3])
    if len(argv) == 3 and argv[1] == "--column-order":
        for t, cols in sorted(column_order(read_statements(argv[2])).items()):
            print(f"{t}: {','.join(cols)}")
        return 0
    if len(argv) == 2:
        print("\n\n".join(normalized(read_statements(argv[1]))))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

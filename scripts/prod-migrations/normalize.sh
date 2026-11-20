#!/bin/sh
# Runs INSIDE the python container (no network). Never connects to anything.
# Usage: sh /p/normalize.sh /work/IN.sql /work/OUT.sql
# OUT = normalize_schema.py --baseline IN: the form whose sha256 is a
# migration's before/after fingerprint (docs/PROD_MIGRATIONS.md s3).
set -eu
[ -s "$1" ] || { echo "normalize: input $1 is missing or empty" >&2; exit 1; }
python -I /sb/normalize_schema.py --baseline "$1" > "$2.partial"
mv "$2.partial" "$2"
python -I /sb/normalize_schema.py --stats "$2"

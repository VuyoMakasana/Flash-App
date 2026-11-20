#!/bin/sh
# Runs INSIDE every runbook container started by Invoke-FlashContainer
# (FlashMigration.psm1). Runs the given command, then prints its exit code on
# a marker line. The PowerShell side reads the exit code from that line, so a
# Docker Desktop fault that leaves a finished container "running" (seen
# during L0.2: no process left inside, `docker run` never returns) cannot
# hang a step or lose the result.
# Usage: sh /p/run.sh COMMAND [ARGS...]
"$@"
code=$?
echo "FLASH_EXIT=$code"
exit "$code"

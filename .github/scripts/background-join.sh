#!/usr/bin/env bash
# Usage: background-join.sh NAME
#
# Waits for a command started by background-start.sh NAME, prints its output,
# and exits with its status.
set -u
name=$1
for ((waited = 0; waited < 1800; waited += 2)); do
  [[ -f "$RUNNER_TEMP/$name.exit" ]] && break
  sleep 2
done
cat "$RUNNER_TEMP/$name.log"
if [[ ! -f "$RUNNER_TEMP/$name.exit" ]]; then
  echo "::error::Background task $name did not finish."
  exit 1
fi
exit "$(cat "$RUNNER_TEMP/$name.exit")"

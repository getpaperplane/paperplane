#!/usr/bin/env bash
# Usage: background-start.sh NAME COMMAND [ARGS...]
#
# Starts COMMAND detached from the current step so later steps run meanwhile.
# Every stream is redirected, so the step does not wait on the process.
# background-join.sh NAME waits for it and replays its output and exit status.
set -u
name=$1
shift
(
  "$@" > "$RUNNER_TEMP/$name.log" 2>&1 < /dev/null
  echo $? > "$RUNNER_TEMP/$name.exit"
) > /dev/null 2>&1 < /dev/null &

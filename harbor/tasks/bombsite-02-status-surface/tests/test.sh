#!/bin/bash
# Harbor runs /tests/test.sh as the verifier. All grading logic lives in
# grade.mjs so it can be exercised locally with plain node.
set -uo pipefail
node "$(dirname "$0")/grade.mjs"

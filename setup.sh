#!/usr/bin/env bash
# Redirect to scripts/setup.sh
exec "$(dirname "$0")/scripts/setup.sh" "$@"

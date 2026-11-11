#!/bin/sh
# gh wrapper: read the token from the macOS keychain at call time so it is never
# written to disk or inlined into a command that could get redacted.
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential-osxkeychain get | sed -n 's/^password=//p')
if [ -z "$TOKEN" ]; then
  echo "no github token in the keychain" >&2
  exit 1
fi
GH_TOKEN="$TOKEN" exec gh "$@"

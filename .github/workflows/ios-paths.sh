#!/usr/bin/env bash
# Paths that can break the iOS archive, read on stdin; matches on stdout, exit 1 when none.
# Sourced by verify.yml's self-test and by its diff step, so both use one definition.
# Only apps/ios and this file: the app shares no build step with the JS workspaces.
ios_paths() {
  grep -E '^(apps/ios/|\.github/workflows/ios-paths\.sh$)'
}

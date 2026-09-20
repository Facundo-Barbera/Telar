#!/usr/bin/env bash
# WHICH CHANGED PATHS CAN BREAK THE iOS ARCHIVE. Sourced twice by the
# `ios-changes` job in verify.yml — once by the self-test that proves this
# expression still answers known cases correctly, once by the step that runs it
# over the real diff. One definition, because a self-test run against a COPY of
# the matcher only ever proves the copy. #767.
#
# Reads paths on stdin, one per line; writes the matching ones to stdout.
# Exits 1 when nothing matched, which is grep's ordinary "no match" and is the
# expected answer on most pull requests — callers must not treat it as an error.
#
# WHAT IS IN, AND WHY EACH:
#
#   apps/ios/**                     Swift sources, the Xcode project, the
#                                   Config plists, ExportOptions.plist, and
#                                   nightly.sh — everything the archive reads.
#   .github/workflows/verify.yml    The gate itself. A change to how the
#                                   archive is invoked has to be archived, or
#                                   the gate is only ever tested by the next
#                                   person to touch a Swift file. This costs a
#                                   Mac on workflow edits, which are rarer here
#                                   than iOS edits and much rarer than either
#                                   kind of web change.
#   this file                       Same reason: widening or narrowing the
#                                   filter must run under the filter.
#
# WHAT IS DELIBERATELY OUT:
#
#   .github/workflows/nightly-ios.yml and ios-export-probe.yml change what
#   PUBLISHES, not what compiles; nightly.sh, which does both, is in via
#   apps/ios/. The JavaScript workspace is out because the iOS app consumes
#   none of it — it is Swift plus three remote SPM packages, and shares no
#   build step with apps/web or apps/desktop.
#
# THE TWO ANCHORS ARE LOAD-BEARING. Without the leading `^…/`, `apps/iosextra/`
# matches; without the trailing `$`, `verify.yml.bak` does. Both cases are in
# the self-test in verify.yml, which is where a change to this line gets
# caught.
ios_paths() {
  grep -E '^(apps/ios/|\.github/workflows/(verify\.yml|ios-paths\.sh)$)'
}

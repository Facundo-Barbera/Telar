"""Offline models of narrow, source-checked CLIProxyAPI contracts.

No sockets, provider calls, credentials, dependencies, or production imports.
These are Python transcriptions, NOT execution of the Go proxy. Times are virtual.
Run: python3 diagnostics/cliproxy-audit/offline-fixtures.py
"""
from pathlib import Path
import json
import re
import subprocess

ROOT = Path('/tmp/telar-cliproxy-audit-7.2.145')
SHA = 'd9cea8904b14fbbebb77ef26e98ef08f6b48a724'
assert subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip() == SHA


def source(path, required):
    text = (ROOT / path).read_text()
    for part in required:
        assert part in text, (path, part)
    return text


source('internal/runtime/executor/helps/claude_device_profile.go', [
    'func plausibleClaudeCLIVersion(candidate, baseline claudeCLIVersion) bool {\n\treturn candidate.Compare(baseline) == 0\n}',
])
source('internal/runtime/executor/helps/claude_client_detection.go', [
    'detection.Confirmed = detection.StrongSignals && detection.NativeClient',
    'return okCandidate && okBaseline && plausibleClaudeCLIVersion(candidate, baseline)',
])
source('internal/runtime/executor/claude_executor_cloaking.go', [
    'Cloak:                (fp.ProfileClaudeCodeCLI || cloakConfigured) && !confirmedClaudeCode,',
    'return !confirmedClaudeCode && (cloaked || countCacheControls(payload) == 0)',
])
source('internal/runtime/executor/claude_executor_stream.go', [
    'if responseFormat == to {',
    "if len(bytes.TrimSpace(line)) == 0 && !flushEvent()",
    'case out <- cliproxyexecutor.StreamChunk{Payload: cloned}:',
])
source('internal/runtime/executor/helps/usage_helpers.go', [
    'usageNode := gjson.GetBytes(payload, "usage")',
    'r.once.Do(func() {\n\t\tr.publishRecord(ctx, r.buildRecord(detail, failed, fail))',
])

results = []
for version, expected in [('2.1.258', True), ('2.1.261', False), ('2.1.257', False)]:
    # Other standard native detector signals are supplied as valid fixture inputs.
    candidate = tuple(map(int, version.split('.')))
    confirmed = candidate == (2, 1, 258)
    assert confirmed == expected
    results.append({'fixture': 'native-version-gate', 'caller': version,
                    'baseline': '2.1.258', 'other_native_signals': True,
                    'confirmed': confirmed,
                    'oauth_default_cloak': not confirmed,
                    'proxy_owns_cache_markers_under_oauth_default': not confirmed})

# A synthetic upstream delays the blank line: the complete-event forwarder
# cannot flush the event until that delimiter. No entire-answer buffering.
parts = [(10, 'event: message_start'), (11, 'data: {"type":"message_start"}'),
         (120011, ''), (120030, 'event: message_stop'),
         (120031, 'data: {"type":"message_stop"}'), (120032, '')]
event, forwarded = [], []
for at, line in parts:
    event.append(line)
    if not line.strip():
        forwarded.append({'virtual_ms': at, 'lines': len(event)})
        event = []
assert [x['virtual_ms'] for x in forwarded] == [120011, 120032]
results.append({'fixture': 'sse-delimiter-delay', 'virtual_not_measured': True,
                'first_upstream_line_ms': 10, 'forwarded_events': forwarded})

# Standard nested start usage plus output-only cumulative delta. The native
# response still forwards these bytes; only the proxy's internal ledger loses input.
events = [
    {'type': 'message_start', 'message': {'usage': {'input_tokens': 32,
      'cache_read_input_tokens': 309592, 'cache_creation_input_tokens': 1868, 'output_tokens': 2}}},
    {'type': 'message_delta', 'usage': {'output_tokens': 20}},
    {'type': 'message_delta', 'usage': {'output_tokens': 30}},
]
published = next((e['usage'] for e in events if 'usage' in e), None)
assert published == {'output_tokens': 20}
results.append({'fixture': 'proxy-usage-top-level-first-publish',
                'published_usage': published, 'correct_final_output': 30,
                'input_cache_usage_present_in_forwarded_start': events[0]['message']['usage'],
                'telar_receives_start_usage_unchanged': True})

# Supplied observation: a cache hit does not classify preceding latency.
ratio = 309592 / (309592 + 1868 + 32)
assert 0.9938 < ratio < 0.9940
results.append({'fixture': 'cache-hit-arithmetic', 'input_cache_reuse': ratio,
                'context_used_including_output_placeholder': 32 + 309592 + 1868 + 2})

output = {'source_sha': SHA, 'validation': 'source-checked Python models; Go suite not executed',
          'provider_calls': 0, 'network_calls': 0, 'results': results}
Path(__file__).with_name('fixture-results.json').write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(output, indent=2))

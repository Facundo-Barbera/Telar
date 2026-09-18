# Claude Code transcript fixtures

Hand-written, and deliberately so. The first attempt derived these from a real
`~/.claude/projects/` transcript with a scrubber; an audit found the scrubber
had missed `rendered`, the `content` of `system` records and the commands
inside `hookInfos`, so real conversation text survived into the fixture. A
scrubber has to be right about every field a foreign CLI might add in its next
release, which is not a property anyone can maintain — so these carry no real
content at all.

What they DO carry is real **structure**. Every field name, nesting, flag and
`uuid`/`parentUuid` link below was read off the transcripts on a working
machine (2,536 files, largest 212 MB) and is reproduced exactly. Structure is
what `claude-transcript.ts` reads; prose is what it copies.

| file | what it is for |
| --- | --- |
| `terminal-session.jsonl` | An ordinary conversation, plus every awkward shape that is not compaction: a `user` record carrying only `tool_result`, an `isMeta` wrapper, a slash-command envelope, `attachment` and uuid-less bookkeeping records, an abandoned edit branch, and a sidechain. |
| `compacted-session.jsonl` | A `system`/`compact_boundary` and the `isCompactSummary` record that follows it — the cut point and the provider's own summary of what came before. |
| `truncated.jsonl` | A file caught mid-append: the last line is half a record. |

Timestamps are fixed so assertions on ordering and `lastActivityAt` are stable.

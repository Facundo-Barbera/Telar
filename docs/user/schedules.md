# Schedules

A schedule sends a session the same prompt on a clock: every 30 minutes, say, or at 9:00 on weekdays. Use it for a morning digest, a check on a long-running job, or a reminder to look at something again.

## Creating one

Ask the agent. For example: "Every weekday at 9:00, summarise the new issues." The agent sets up the schedule for its own session. You can't create a schedule from the cockpit itself, and an agent can only schedule its own session, never another one.

A schedule has:

- **A prompt**: what gets sent to the session each time.
- **A rule**: either every N minutes (one minute at least), or a time of day, on every day or on the weekdays you pick.
- **A time zone**: your Mac's, unless you ask for another.

## When it runs

When a schedule is due, Telar sends its prompt to the session as an ordinary turn, just as if you had written it. The answer lands in that conversation's transcript.

## Seeing and removing schedules

A session with schedules shows a clock with their number at the top of the conversation. Open it to see each schedule's prompt, its rule, the next run with its time zone, and when it last ran or was skipped. Delete a schedule from there. To change one, delete it and ask the agent for a new one.

Schedules are listed only in their own conversation. There's no page that gathers every schedule.

## What's not obvious

- Telar has to be open. A schedule runs inside Telar, not in the background of your Mac, so nothing fires while Telar is closed.
- A missed run is skipped, not run late. If Telar was closed at 9:00, the 9:00 run doesn't happen at noon. The schedule shows the skip and waits for the next 9:00. A run up to five minutes late still happens, so a lid closed for a moment doesn't lose it.
- An "every N minutes" schedule simply carries on from the next interval. After three days away, it runs once, not once for every missed interval.
- The time zone stays with the schedule. A schedule set for 9:00 in Madrid keeps running at 9:00 Madrid time even when your Mac is somewhere else.
- There's no "run now". To get the result early, send the prompt yourself.
- Deleting the session stops its schedules.

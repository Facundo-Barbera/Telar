# Agents working together

A session can start other sessions, hand them work, and collect their results. You can ask one session to split a list of issues across several workers, for example. It then coordinates them while you watch, and brings you only the decisions that are yours to make.

## How it works

Every session has Telar's sessions tools. With them, an agent can:

- list the live sessions and the projects it can create sessions in,
- create a new session on a project, in the project's checkout or in a worktree of its own,
- send another session a message,
- read what another session has done, check whether it's finished, and see its diff,
- be woken when the sessions it tasked are done,
- stop a session that is going wrong, or settle one whose work is finished.

Creating a session starts no work. Work starts when the coordinator sends it a task.

## Messages between sessions

Each message has an intent:

- **Task**: assigns work. It links the worker to the session that sent it.
- **Result**: the worker's final answer, sent once when the task is done.
- **Blocker**: the worker needs a decision before it can go on.
- **Report**: progress along the way.

A task, a result or a blocker wakes the session it's sent to. Reports never start a turn. They are held, and they reach the session with its next turn.

The coordinator doesn't poll. It sends the tasks, subscribes to the whole group of workers, and ends its turn. Telar wakes it once, when every worker has sent its result, failed, been stopped or been settled. A blocker, or a worker stuck waiting on a request, reaches it right away.

## Orchestrate

Type `/orchestrate` in the composer and paste your list. The orchestrate skill has the coordinator:

1. read the project's rules note in the notebook, if there is one,
2. turn the list into one task per issue, and ask you only about decisions that are yours,
3. start one worktree session per task and brief each one,
4. check each result before anything is merged, and merge only with your permission,
5. pass each worker's blockers to you, with a recommendation,
6. settle the workers when their work is done, and keep you updated with a short summary.

`/orchestrate` shows up only when the skill is installed. Telar installs it together with the telar skill, under Settings → Agent tools → Telar orientation.

Standing rules that differ per project, such as who may merge or how many workers may run at once, belong in a note in that project's notebook. The coordinator reads it before it starts.

## Seeing who works for whom

The Agents tab in the panel shows the relationships around a conversation:

- **Working for this conversation**: the sessions this one tasked, with how each errand ended. If you follow one of them here, this conversation is woken when it finishes.
- **Working for**: the conversation that handed this one its task.
- **Reports from peers**: reports waiting for this conversation's next turn.

Delegated sessions are ordinary sessions in the rail. Open one to watch it or talk to it directly.

## What's not obvious

- A session never gets more access than the session that created it. If the coordinator has to ask before running commands, its workers have to ask too.
- Something a session was denied stays denied when another session tries it. An agent can't get around a refusal by asking a peer.
- A coordinator can answer an approval that a worker is waiting on, and Telar records who answered. It can't answer requests for secrets. It also can't merge work, archive sessions or delete them.
- Sessions don't clean up after themselves, and every worktree session is a full checkout on your disk. Once its result has been delivered, a delegated session settles on its own after a while. Pinned sessions, failed errands and sessions with an open question stay in the list. Set this under Settings → General → Settling.
- Settling a worker just moves it out of the way. It doesn't mean its work was accepted.

# Composer

The composer is where you write to the agent. Next to the message box sit the session's model, reasoning effort and access mode. You can set each one there or with a slash command.

## Model and effort

- **Model**: search the list, mark favourites, and open Legacy models for older ones. A new session picks its provider here. After that, a model change applies from the next turn.
- **Reasoning**: Auto or one of the model's effort levels. Claude also offers Ultracode (extra-high reasoning that can plan and run multi-step workflows on its own) and Ultrathink (adds the word "ultrathink" to this message only). Depending on the model you can also set the context window, fast mode (Claude) or the service tier (Codex).

`/model <name>` and `/effort <level>` do the same from the keyboard.

## Access

The access mode decides what the agent may do without asking you:

| Mode | Command | What asks |
| --- | --- | --- |
| Supervised | `/supervised` | Everything except reading files |
| Auto-accept edits | `/auto-edits` | Everything except reading and editing files |
| Auto | `/auto` | A reviewer waves routine actions through |
| Full access | `/full-access` | Nothing |

Questions from the agent and requests for secrets always wait for you, in every mode. Set the default for new sessions in Settings → General → New sessions → Access. See [Permissions and requests](permissions.md).

## Attachments

Add up to 16 photos or files with the add menu, by pasting, or by dropping them on the box. You can also drop a file from the panel, or a note, as a reference. It's inserted as a chip instead of attached.

## Slash commands and mentions

- `/` lists Telar's commands first, then the provider's own. A command that would do nothing right now isn't listed. `/compact` is the exception: it stays and says why it's unavailable.
- `@` completes file and folder paths in the project.
- `$` inserts one of the provider's installed skills.

Only on a new session: `/claude` and `/codex` pick the provider, `/local` and `/worktree` pick where it works, and `/resume` picks up a Claude Code conversation (see [Providers](providers.md)).

## While a turn is running

Enter always sends. If a turn is running, the message goes into that turn, and the agent reads it at its next step. It appears inside the running turn in the transcript. OpenCode can't take messages mid-turn, so there the message waits until the turn ends.

To stop a turn, press ⌘., press Escape twice (the first press arms it), or use the stop control when the box is empty. `/stop` works too.

## Questions from the agent

When the agent asks you something, the question opens right above the composer, one at a time. Pick an option with 1–9 or type your own answer, then press Enter. Cancel the turn if you'd rather not answer.

## Drafts and the stash

- Whatever you type is kept as a draft per session, even if you close Telar.
- ⌘S sets the current message aside in the stash. ⌘S with an empty box opens the stash. Picking a prompt puts it back in the box and removes it from the stash. Prompts that agents prepared for you appear there too, under "Drafted for you". See [Notes and prompts](notes-and-prompts.md).

## Dictation

Dictation is off until you choose a speech provider in Settings → Dictation. That needs your own key for the provider, and audio goes straight from your device to it, not through the Mac. Then press ⌘D, or use the microphone, to dictate. Add names Telar can't guess (people, products) under Vocabulary.

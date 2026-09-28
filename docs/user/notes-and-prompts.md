# Notes and prompts

Telar keeps two kinds of text beside a project: notes you want to keep, and prompts waiting to be sent.

## The notebook

The notebook holds quick notes about a project: how to deploy, a constraint to remember, a decision you don't want to explain twice. Notes belong to the project, so every session on it sees the same notebook.

Open it with Notes at the top of a conversation. Add a note, give it a title and write the body in Markdown. There's no save button: a note is saved when you click away, or with ⌘S. A new note isn't created until it has a title, so opening one and pressing Escape leaves nothing behind.

- **Pin** a note to keep it at the top of the list.
- **Use a note in a message**: type `@` in the composer and the matching notes are offered before the files. You can also drag a note from the notebook into the composer. Either way, the note's text goes into your message.
- **Delete** a note from its editor. Deleting is permanent.

## Agents and the notebook

Agents can list, read and write notes in their project's notebook. They don't see it unless they look, so ask the agent to read a note, or mention it with `@`, when it matters.

- A note an agent wrote is marked as the agent's, for good.
- Agents can delete only notes that agents wrote. Your own notes are yours.
- Agents are told to write a note when you ask them to keep something, not to log their work.

A note is also a good home for standing rules for a project, such as who may merge. A coordinating session reads the project's rules note before it starts. See [Agents working together](agents-together.md).

## The stash

The stash holds prompts you've set aside and prompts agents have prepared for you.

- ⌘S in the composer sets the current message aside, images included, and empties the box.
- ⌘S with an empty box opens the stash. Picking a prompt puts it back in the box and takes it out of the stash.
- Your stash is kept in the app or browser you're using, and follows you across every session and project. It holds the 20 most recent prompts.

See [Composer](composer.md) for everything else about writing messages.

## Prompts drafted for you

An agent can end a turn by preparing the follow-up it would send next, or write a prompt because you asked for one. It lands in your stash under "Drafted for you", with a line on why the agent offered it.

Nothing runs until you pick it and send it. Read it first: sending it counts as your own message. Drafts belong to the project, and a follow-up drafted in one conversation appears only in that conversation's stash. Agents can remove drafts that agents wrote, but never a prompt you stashed.

## What's not obvious

- Notes are shared by the whole project. Prompts you stash are shared by the whole app, but not between your Mac, another browser and your phone.
- A note sent with `@` goes into the message as text. Editing the note later doesn't change messages already sent.

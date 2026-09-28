# Keyboard shortcuts

Telar is built to be driven from the keyboard. Every shortcut can be changed, and the command palette reaches everything that has no key.

## The command palette

Press ⌘K to open it. It has four sections, always in this order:

- **Actions**: every command that can run where you are right now. A command whose surface isn't on screen (Send with no conversation open, Open Data in a project without the Data plugin) doesn't appear.
- **Quick settings**: the colour scheme, the Look, the accent, text size, translucency and the rail. These apply on Enter instead of opening Settings, and show their current value.
- **Projects**: start a conversation in one.
- **Recent conversations**: the eight most recent, across every project. Type to search all of them.

Some rows open a second page (a project list, the Looks, the accents). Backspace in an empty field goes back.

## Default shortcuts

On a Mac, ⌘ is Command and ⌥ is Option. In a browser on another system, Ctrl stands in for ⌘.

| Shortcut | Command |
| --- | --- |
| ⌘N | New conversation |
| ⌘T | New tab |
| ⇧⌘N | New window |
| ⌘L | Focus the composer |
| ⌘Return | Send |
| ⌘. | Stop the running turn |
| ⌘D | Dictate |
| ⌘O | Reveal in Finder |
| ⌘P | Pin or unpin the conversation |
| ⌘K | Command palette |
| ⌘B | Show or hide the rail |
| ⌘1 – ⌘9 | Jump to the Nth conversation in the rail |
| ⌘\ | Show or hide the right panel |
| ⌥⌘→ / ⌥⌘← | Next / previous panel tab |
| ⌥⌘F | Panel fills the window |
| ⇧⌘D | Open Diff |
| ⇧⌘E | Open Editor |
| ⇧⌘B | Open Data |
| ⇧⌘X | Open LaTeX |
| ⇧⌘P | Go to file |
| ⌥⌘I | Developer tools |
| ⌘, | Settings |
| ⇧⌘, | Search settings |

New conversation in…, Add project, Appearance, Project settings, Usage, Plugins and Check for updates have no key by default. Find them in the palette, or give them one.

## Things worth knowing

- Hold ⌘ and every control with a shortcut shows its key. Let go and the hints disappear.
- ⌘1–⌘9 count the rail as it is drawn, top to bottom, skipping settled rows and folded groups.
- In a browser tab, the browser keeps some keys for itself (⌘N, ⌘T, ⌘1–⌘9 among them). The desktop app has no such conflict.
- Panel shortcuts only work where there is a panel, for example inside a conversation.

## Changing a shortcut

Settings → Keybindings. Click a shortcut and press the new one. Backspace clears it, Escape leaves it as it was, and Restore defaults puts them all back.

- The nine jumps change together: press any digit with the modifiers you want, and each slot gets its own digit.
- Two commands can share a key while you're in the middle of a swap. Telar flags the clash, and the command listed first wins until you fix it.
- System keys such as ⌘Q and ⌘C can't be recorded in the desktop app.
- Keybindings are saved per browser: the desktop app and each browser you use keep their own set.

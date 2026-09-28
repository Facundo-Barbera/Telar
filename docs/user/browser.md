# Integrated browser

Telar has its own browser, shared between you and your agents. An agent can open your app, click through it, read the console and take screenshots while you watch the same pages in the panel.

## Opening it

Open the Browser tab in a conversation's panel (see [The panel](panel.md)). It has the tabs, address bar and back, forward and reload of an ordinary browser. A tab's menu can also open the page in your system browser.

The full browser lives in the desktop app. In a browser tab or on the iPhone, the panel shows screenshots of the session's pages instead, so you can still follow what an agent is doing.

## You and the agent share it

- An agent gets its own tab. It works there without moving the page you're looking at.
- Its tabs appear in the panel's tab strip, but they don't open the panel or switch your tab.
- When the agent is driving the tab you're looking at, the browser shows a quiet mark so you know.
- You can ask about "the page I have open": the agent sees which tab is yours.

## Profiles

A profile is a separate set of cookies, storage and logins. Use one per account or client, so being signed in to a staging site as one user never leaks into another.

- Every project browses in the default profile unless you pick another for it from the browser's profile picker. Several projects can share a profile.
- Switching profile changes where the next tab opens. Tabs already open stay signed in as the profile they were opened with.
- Create profiles from the browser's profile picker or in Settings → Browser. Each needs a name, and can get an icon and a colour so you can tell them apart in the toolbar.
- Changing the default moves every project that hasn't picked its own.
- Deleting a profile sends its projects back to the default, and their tabs reopen signed out.

## Filling logins from 1Password

An agent can ask to sign in to a site with a login from your 1Password. Telar shows a request with the matching logins. You choose one and approve it, and Telar fills the fields straight into the page. The password never enters the conversation or reaches the model. See [Permissions and requests](permissions.md).

This needs the 1Password CLI, with "Integrate with 1Password CLI" turned on in the 1Password app's Developer settings. 1Password asks you to unlock as usual.

The request has an unticked box to let agents use that login again without asking. It covers only that login, in that profile, on that exact address. Settings → Browser → Remembered logins lists these and lets you revoke each one.

## Viewport and appearance

The device toolbar resizes the page to a preset: phones, tablets, desktops and foldables, in portrait or landscape. You can also drag the page's edges to any size, and zoom it to fit. You can make the page think the system is in light or dark mode, to check both.

## Annotating a page

Use the pen to mark up what you see. Telar freezes the page and gives you a rectangle, an arrow, freehand, text labels, and a picker that names the element you click. Undo removes the last mark. When you're done, the marked-up picture goes into the composer, with a note of any elements you picked. The agent then knows exactly which button you mean. The camera attaches a plain screenshot, of the viewport or, with a right-click, the full page.

## Site permissions

The first time a site wants the camera, microphone, notifications, location, the clipboard or screen sharing, Telar asks from the address bar. Settings → Browser → Site permissions lists your answers so you can change them.

## What's not obvious

- Profiles and site permissions exist only in the desktop app. Settings → Browser says so when you open it elsewhere.
- The page isn't live while you annotate. It comes back when you send or cancel.
- A remembered login still needs 1Password to be unlocked.

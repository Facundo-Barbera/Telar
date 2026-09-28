# Plugins

Plugins add tools for agents, panel tabs and settings to Telar. Two come with Telar, Data Science and LaTeX, and you can add your own from a folder.

## Turning a plugin on

A plugin runs in a project only when two switches agree:

- **This Mac**: Settings → Plugins lists every plugin. Turning one off there makes it unavailable in every project. Each project keeps its own setting, so turning it back on restores what each project had. Work that's running finishes first.
- **The project**: Settings → Projects, under the project, has a switch per plugin. The plugin's own settings for that project appear once it's on.

Once it's on, agents in that project get the plugin's tools and the panel gets its tab. Settings → Plugins also holds each plugin's Mac-wide defaults, which a project uses when it hasn't chosen its own.

## Data Science

Data Science gives a session a Python kernel. Agents can run code and notebook cells in it, and you can follow along.

- **Notebooks** open in the panel as cells. Edit a cell and press ⇧Return to run it in the session's kernel. Cells the agent runs show up with their output, because you and the agent work on the same file.
- **The Data tab** (⇧⌘B) shows plots, the kernel's variables and its environment. You can interrupt or restart the kernel there. Restarting loses every variable.
- **Environments**: in Settings → Projects, pick the Python environment the kernel runs in, such as the project's own virtual environment, a conda environment or another interpreter. Telar can create one for you, and install uv, conda or a Python version if they're missing. Installs run with their log on screen.
- **Packages**: the same page lists what's installed in the chosen environment and can install more. An agent can install packages too, after you approve it. Set the packages every new environment gets in Settings → Plugins.

## LaTeX

LaTeX lets agents compile documents and fix their errors.

- **The LaTeX tab** (⇧⌘X) shows the last compile, its errors and warnings, and the end of the log. Click an error to open its file. Open PDF opens the result in the panel.
- **Setup**: in Settings → Projects, choose the project's main .tex file and the engine (pdflatex, or xelatex or lualatex for documents that need system fonts).
- **Distributions**: Telar can download its own Tectonic, which needs nothing else installed. It also finds TeX Live (MacTeX, TinyTeX) and a system Tectonic, and can install one for you. The Mac-wide default is in Settings → Plugins, and a project can pick its own.
- **Packages**: with a TeX Live distribution, you can list and install TeX packages from the project's settings. Tectonic fetches the packages it needs on its own.

## Adding a plugin from a folder

Settings → Plugins → Add plugin from folder, then choose the plugin's folder:

- **Copy** installs a copy. Removing the plugin later deletes that copy.
- **Link** uses the folder where it is, so you can keep editing it. Removing the plugin only removes the link.

Telar checks the plugin before it installs it, and tells you why if it refuses. A plugin that fails to start stays in the list with the reason, and Telar keeps working without it. After installing, turn it on for the projects that need it.

## What's not obvious

- Telar never treats a tool from a plugin you added as a harmless read. It goes through the same approvals as a command or an edit. See [Permissions and requests](permissions.md).
- The Data and LaTeX tabs, and their shortcuts, only appear in projects where the plugin is on.
- Each session has its own kernel, even on the same project.

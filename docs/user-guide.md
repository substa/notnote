# notd — Documentation

notd is a local Markdown editor, block outliner, and reader for file-based graphs. Markdown files remain the source of truth; notd does not introduce a proprietary data format.

## Quick start

### Local editor

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`, then use **Open local graph** from the command palette to select a folder.

### Shared LAN graph

```bash
python3 server.py \
  --host 0.0.0.0 \
  --port 4176 \
  --graph /absolute/path/to/graph
```

Open `http://localhost:4176` on the server or `http://SERVER-IP:4176` from another device. Every client reads and writes the same files.

> The graph API has no application authentication. Use it only on a trusted network and never expose it directly to the internet. Remote deployment requires TLS and access control at a reverse proxy; every user admitted by that proxy can read and modify the complete graph.

## Installation and PWA

notd can run in a normal browser tab or as an installed Progressive Web App. Installation requires HTTPS, except on `localhost`.

### Docker

The `docker/` directory contains the Dockerfile, Compose stack, environment template, and a complete [deployment guide](./deployment.md). The container exposes notd only on server loopback for diagnostics and on a private Docker network shared with Newt. Pangolin (or different access platform) must require authentication before forwarding traffic to `http://notd:4176`; never expose the writable Python API directly to the internet.

## Command palette

Open the command palette with:

- `⌘/Ctrl + K`;
- `⌘/Ctrl + Shift + P`;
- `F1`;
- `:` in Vim Normal mode.

Use the palette for application actions: find pages and blocks, change themes, open files, navigate journals, manage graph maintenance, and open this documentation. Formatting tools stay in the editor toolbar, keyboard shortcuts, and inline autocomplete instead of appearing in the command list.

## Commands

The command palette supports the following application commands. Commands marked **Graph** are useful only while a graph is open. Displayed shortcuts are the current bindings and can be changed in **Settings → Shortcuts**.

| Command | Scope | What it does |
| --- | --- | --- |
| **Settings** | Any | Opens the General settings panel. |
| **Documentation** | Any | Opens this user guide inside notd. |
| **Open local graph** | Any | Selects a local graph folder through the browser File System Access API. |
| **Sync all notes and backlinks** | Graph | Rescans Markdown notes and rebuilds page, block, backlink, and autocomplete indexes. |
| **Clean orphaned assets** | Graph | Reviews and, after confirmation, deletes files in `assets/` that are not referenced by any note. |
| **Clean empty pages** | Graph | Reviews and deletes blank, unreferenced, non-journal pages after confirmation. |
| **New graph page** | Graph | Prompts for a title and creates a page in `pages/`. |
| **Today journal** | Graph | Opens today's journal. |
| **Task dashboard** | Graph | Opens the complete task dashboard. |
| **All pages** | Graph | Opens the searchable alphabetical page directory. |
| **Previous page** | Graph | Goes back in graph navigation history. |
| **Next page** | Graph | Goes forward in graph navigation history. |
| **Copy block reference** | Graph | Adds an `id::` property when needed and copies the selected block reference as `((UUID))`. |
| **Zoom into block** | Graph | Makes the selected block the root of the current outliner view. |
| **Close graph** | Graph | Closes the graph and returns to the single-document editor. |
| **Rename document** | Any | Focuses and selects the current document or page title for editing. |
| **Find in document** | Any | Opens search for the current document or page. |
| **Export HTML** | Any | Downloads the current document or page as a standalone `.html` file. |
| **Full Markdown source** | Any | Toggles between the visual editor and the complete Markdown source. |
| **Toggle Vim mode** | Any | Enables or disables Vim-style keyboard navigation and editing. |
| **Light theme** | Any | Selects the light interface theme. |
| **Dark theme** | Any | Selects the dark interface theme. |
| **System theme** | Any | Follows the operating system's light or dark preference. |

The palette also produces contextual results rather than fixed commands:

| Result | What it does |
| --- | --- |
| **Outline: _heading_** | Jumps to a heading found in the current Markdown document. |
| **Page or alias result** | Opens a graph page; aliases show and open their canonical page. |
| **Block result** | Opens the source page and focuses the matching block. Block search starts after two typed characters. |
| **Recent document result** | Opens a standalone document stored by notd. |
| **Create page “…”** | Creates a graph page when the typed title does not already exist. |

### Inline commands

Inside a graph block, type `/` to open inline commands:

| Command | What it does |
| --- | --- |
| `/todo` | Sets the block task state to `TODO`. |
| `/doing` | Sets the block task state to `DOING`. |
| `/done` | Sets the block task state to `DONE`. |
| `/scheduled` | Opens the date picker and adds or updates the block's scheduled date. |
| `/today` | Inserts a reference to today's journal. |
| `/yesterday` | Inserts a reference to yesterday's journal. |
| `/tomorrow` | Inserts a reference to tomorrow's journal. |
| `/date picker` | Opens the date picker and inserts a reference to the selected journal date. |
| `/upload` | Uploads a file to `assets/` and inserts its Markdown link. |

Type `<` in a graph block to use structural commands:

| Command | What it does |
| --- | --- |
| `<quote` | Inserts an Org-style quote block and places the caret inside it. |
| `<src` | Inserts a fenced code block and places the caret inside it; an optional language can follow the command, for example `<src javascript`. |

## Find in the current document

Press `⌘/Ctrl + F` and start typing to highlight every occurrence in the current document. The counter shows the selected occurrence and the total number of results.

- Next occurrence: `Enter` or `⌘/Ctrl + G`;
- previous occurrence: `Shift + Enter` or `⌘/Ctrl + Shift + G`;
- close search: `Escape`.

## Settings

Open the page menu from the gear icon at the right side of the footer. It provides **New page**, **Delete page** when the current page can be deleted, **Page history**, **Settings**, **Shortcuts**, and **Documentation**. You can also open Settings directly with `⌘/Ctrl + ,`.

- **General** controls the light, dark, or system theme, the accent color, and Vim mode.
- **Shortcuts** lists keyboard commands by section. Search the list, select a shortcut, and press a new key combination to replace it. Use **Reset** to restore its default.
- **Documentation** contains this complete guide. Its **On this page** menu jumps directly to every main section; on mobile it appears as a section selector.

When a graph is open, these preferences and custom shortcuts are saved in `.notd/settings.json` and follow the graph across devices.


## Graphs

### Offline PWA use

After a server graph has been opened successfully at least once, notd keeps a local replica of its notes and settings in IndexedDB. The installed PWA can then open the graph without a connection, edit existing notes, and create new pages or journals. Changes are applied immediately to the local index and placed in a persistent synchronization queue.

The footer reports **Offline** and the number of pending changes. Synchronization starts when the browser reports that it is online, when the PWA returns to the foreground, or when its window receives focus. This does not rely on Background Sync, which is unavailable on iOS; the PWA must be open or resumed for synchronization to run.

Each queued write retains the server revision from which it started. If that revision is still current, the change is uploaded automatically. If the server version changed in the meantime, notd preserves the local operation and reports a synchronization conflict instead of overwriting either version. Page renaming, deletion, and attachment upload currently require a connection.

The Service Worker caches the application shell and, on demand, graph attachments that have been opened successfully. Cached images, documents, audio, and video remain available offline; media range requests are served from the complete cached file. In **Settings → General**, **Offline attachment cache** sets the storage limit for the current device (200 MB by default). The cache also keeps at most 100 files and removes the oldest entries when either limit is exceeded. Reducing the setting trims the existing cache immediately. Storage remains best-effort because the browser, particularly iOS, can enforce a smaller quota or reclaim site data. Notes and pending operations are stored separately in IndexedDB rather than by indiscriminately caching graph API responses.

A graph can contain:

```text
pages/
  Example.md
journals/
  2026_07_17.md
assets/
```

notd reads `.md` and `.markdown` files from the graph root, `pages/`, and `journals/`. It recognizes page titles, aliases, properties, page references, block UUIDs, and journal dates. Aliases declared with `alias::` are searchable in the command palette; an alias result displays the canonical page title and opens that page. `key:: value` properties—including custom fields such as `company::` and `name::`—remain preserved in Markdown source but are hidden from the formatted page when they have no visual representation.

### Open a page

Open the command palette and search for its title. Global search also includes block content. Selecting a block result opens it directly.

### Create a page

Type `[[`. notd immediately inserts `]]` and leaves the caret between the brackets:

```text
[[|]]
```

Enter at least two characters to display page suggestions. If the page does not exist, choose **Create page** and press `Enter`. The reference is completed and the page is created. The caret remains immediately after the closing `]]`, so typing can continue in the same block.

### Rename a page

Use **Rename document** or `F2`, edit the title, then select the minimal checkmark icon to save. The adjacent trash icon deletes the current page after confirmation. notd can update matching `[[...]]` references throughout the graph. Case-only changes such as `test` to `Test` are supported, including on case-insensitive filesystems. Journal pages cannot be renamed or deleted, preserving journal invariants.

### Page history

Page history and automatic Git snapshots are optional. Every editing, saving, synchronization, offline, and backup feature continues to work when Git is absent. History is available only when the graph directory is already a Git repository, Git is installed separately in the `server.py` environment, and notd is running through `server.py`. notd does not install Git or initialize a repository automatically.

For a graph that is not yet under version control, [install Git separately](https://git-scm.com/downloads) and run the following commands once, replacing the path with the graph's location. Docker users must also select the optional `runtime-git` image target described in the [deployment guide](./deployment.md):

```bash
cd /absolute/path/to/graph
git init --initial-branch=main
git add .
git commit -m "Initialize graph history"
```

If Git requests an author name or email, configure them by following the official [first-time Git setup](https://git-scm.com/book/en/v2/Getting-Started-First-Time-Git-Setup). More information about repository creation is available in the [`git init` documentation](https://git-scm.com/docs/git-init).

After the initial commit, open **Settings → Git**. Automatic commits can group nearby graph changes into one snapshot after a delay of 5, 10, 30, or 60 seconds. Commit messages describe the staged changes, for example `Update Earth`, `Add journal 2026-07-22`, `Rename Old page to New page`, or `Update Earth and Marvin`. **Push after commit** publishes each snapshot through the current branch's configured upstream; Git credentials must already be available to the operating-system user running `server.py`. notd never stores Git credentials.

Use **Commit now** or **Commit and push now** to create a snapshot without waiting for the delay. Changes made externally by other applications are detected and included. Repository hooks are disabled for commits created by notd, preventing older `pre-commit` or `post-commit` automation from running twice.

Automatic Git synchronization does not pull, rebase, force-push, or resolve conflicts. All editing devices are expected to use the same notd server. If remote history is changed independently, reconcile it manually before enabling push again. A push failure does not affect the saved Markdown files or the local commit.

After at least one commit exists, choose **Page history** from the footer menu to display up to 100 commits for the current Markdown file. Each entry shows the short commit hash, subject, author, and date. Expand a commit to load and display its unified diff for that page; diffs are fetched only when requested. Added lines are highlighted in green, removed lines in red, hunk headers in cyan, and Git metadata uses the same syntax palette as code blocks. Select **Restore this version** and confirm to replace the current page with the complete Markdown content stored in that commit. The restore is written as a normal page change, so it can become a new snapshot without rewriting Git history. Rename history is followed when Git can detect it, and a notice appears when the working copy has uncommitted changes; restoring while that notice is present replaces those uncommitted changes.

The browser cannot inspect Git repositories opened directly through the File System Access API, so this feature is unavailable in direct local graph mode. The Docker image includes Git. notd invokes Git with argument arrays rather than a shell and restricts the requested path to the configured graph.

## Blocks and outliner

Each bullet is a block. Nested blocks are stored through Markdown indentation.

| Action | Command |
| --- | --- |
| Create the next block | `Enter` |
| Insert a line in the same block | `Shift + Enter` |
| Indent | `Tab` or swipe right on a block |
| Outdent | `Shift + Tab` or swipe left on a block |
| Move up or down | `Alt + ↑/↓` |
| Delete an empty block | `Backspace` |
| Select multiple blocks | `⌘/Ctrl + click`; use `Shift + click` for a range |
| Delete selected blocks | `Backspace` |
| Clear the block selection | `Escape` |
| Cycle the task state | `⌘/Ctrl + Enter` |
| Collapse or expand children | Arrow beside the bullet |
| Zoom into a block | Click the bullet |

Editing does not add a border or background to the active block. To select blocks for a bulk action, use `⌘/Ctrl + click`; `Shift + click` extends the selection across the visible range. Selected blocks are highlighted and can be deleted together with `Backspace`. Deleting a parent block also deletes its nested blocks.

## Tasks

Open the complete task dashboard with `⌘/Ctrl + Shift + K` or the **Task dashboard** command. The shortcut can be changed from **Settings → Shortcuts**.

Task status controls behave consistently in journal blocks, regular pages, the journal task summary, and the complete task dashboard. Clicking the status indicator changes the state; clicking the task text in a dashboard still opens its source block.

| Interaction | From `TODO` | From `DOING` | From `DONE` |
| --- | --- | --- | --- |
| Click or tap | `DONE` | `DONE` | `TODO` |
| `Shift + click` | `DOING` | `TODO` | `DOING` |
| Press and hold | `DOING` | `TODO` | `DOING` |
| `⌘/Ctrl + Enter` while editing | `DOING` | `DONE` | `TODO` |

A normal click is therefore the quick completion action. Use `Shift + click` when a task should be marked as in progress instead, or hold the status control for about half a second on a touch device. Moving the pointer or finger cancels the hold gesture. Devices that support vibration provide brief feedback when the long press is recognized.

`Shift + click` on a task status is reserved for changing its state and does not extend the block selection. On an empty block, `⌘/Ctrl + Enter` inserts `TODO ` and leaves the caret after the space, ready for the task text. It otherwise preserves the complete keyboard workflow:

```text
TODO → DOING → DONE → TODO
```

Changes made from a task summary or dashboard are written back to the task's original Markdown page. Before a task moves to another section or disappears from the current filtered list, its row briefly displays **Completed**, **In progress**, or **To do** to confirm the new state.

Dashboard tasks with a scheduled date are ordered from the nearest date to the farthest. Clicking a scheduled date opens the mini calendar on that month with the currently assigned day selected. Tasks in progress appear at the bottom of **Today** in the journal summary, mini calendar, and complete dashboard. When completed, they remain visible as done in the daily view for the rest of the day, including tasks created on earlier dates. Completed tasks are ordered by completion time, newest first. When notd marks a task as `DONE`, it records a hidden `completed-at::` property in the block; existing completed tasks without this property fall back to their journal date or page modification time.

Task-state changes participate in the regular undo/redo history, including changes made from summaries and dashboards. Use `⌘/Ctrl + Z` to restore the previous state and `⌘/Ctrl + Shift + Z` (or `⌘/Ctrl + Y`) to reapply it. Undo and redo update the task in its original Markdown page and show a confirmation message with the restored state.

## References

### Page references

```text
[[Page name]]
[[Page name|Label]]
#tag
```

Click a reference to open its page. A missing page opens as a virtual page so its backlinks can be viewed; a Markdown file is created only after you edit it. Page references, block references, and `#tags` inside fenced code blocks are treated as code and excluded from the graph index.

### Block references

Select a block and run **Copy block reference**. When required, notd adds:

```text
id:: UUID
```

The copied reference has this form:

```text
((UUID))
```

### Linked references

Single pages show references grouped by source page. The source title and all matching blocks share one card. Blocks with nested content can be expanded directly inside linked, block, and unlinked references. Reference groups are always ordered from the most recent source page to the oldest. For journals, the date displayed in the page title is authoritative; the filename-derived date is used only when the title cannot be parsed. This keeps imported journals correctly ordered when their filenames contain different dates. Other pages use `created-at::`, `created::`, or the file modification date. Unlinked references are available on demand, while block references are shown when a referenced block is zoomed.

## Journals

Opening a graph displays today's journal. If its file does not exist, notd creates it automatically.

The default filename is:

```text
journals/yyyy_MM_dd.md
```

Previous journal pages appear below today's entry and load progressively while scrolling. Future journal pages are excluded from this feed and remain accessible by searching for their name or selecting their date in the mini calendar. Click a journal title to open that date as a single page. When previous-year entries exist and today's journal is empty, its first empty block is shown below the title and task count, followed by the **on this day** timeline. The timeline moves to a collapsible link at the bottom of today's entry as soon as the empty block receives focus; when no block is available, click the featured **on this day** title to collapse it manually. The timeline includes all top-level blocks created on the same month and day in previous years; blocks tagged `#worklog` are excluded. Inline formatting, page references, regular Markdown links, code, quotes, and attachments remain rendered inside the timeline. Timeline blocks with nested content can be expanded in place.

### Journal commands

| Action | Command |
| --- | --- |
| Open today's journal | `⌘/Ctrl + Shift + J` |
| Insert today's journal reference | `/today` |
| Insert yesterday's journal reference | `/yesterday` |
| Insert tomorrow's journal reference | `/tomorrow` |
| Insert a selected journal date | `/date picker` |
| Upload an attachment to `assets/` and insert its Markdown link | `/upload` |
| Previous page | `Alt + ←` |
| Next page | `Alt + →` |

Type `/` inside a graph block to show the inline command menu directly below the block. Journal commands insert `[[page references]]`; the date picker only selects and inserts a date and does not navigate away from the current page.

Type `<` to use structural insertion commands:

| Command | Result |
| --- | --- |
| `<quote` | Inserts an Org-style `#+BEGIN_QUOTE` / `#+END_QUOTE` block and places the caret inside it. |
| `<src` | Inserts a fenced Markdown code block and places the caret inside it. An optional language is supported, for example `<src javascript`. |

## Vim mode

Run **Toggle Vim mode** from the command palette. For an open graph, the setting persists in `.notd/settings.json` and follows the graph across devices.

### Modes

- `i`, `a`, `I`, `A`: enter Insert mode;
- `Esc` or `Ctrl + [`: return to Normal mode;
- `o`, `O`: create a block and enter Insert mode.

### Movement

- `h`, `j`, `k`, `l` or the arrow keys;
- `w`, `b`, `e`: word motions;
- `0`, `^`, `$`: line start, first non-blank character, and line end;
- `gg`, `G`: first and last loaded block;
- `Ctrl + D`, `Ctrl + U`: move rapidly down or up;
- `Enter` in Normal mode: next block.

In the journal feed, `j` and `k` cross journal boundaries. Reaching the end of the loaded journals automatically loads more dates.

### Editing

- `x`, `X`: delete characters;
- `dd`: delete the block;
- `D`: delete to the end of the line;
- `C`: change to the end of the line;
- `r`: replace one character;
- `u`: undo;
- `Ctrl + R`: redo.

Press `?` in Normal mode to open this documentation.

## Navigation

notd keeps page history, including journals, zoom state, and scroll position:

- `Alt + ←`: back;
- `Alt + →`: forward.

The graph name in the top-left corner opens the command palette.

## Data storage and backups

Markdown files remain the authoritative graph data. notd stores graph preferences in `.notd/settings.json`; this includes appearance, shortcuts, Vim mode, recent pages, collapsed blocks, and journal formats. The folder can be included in normal graph backups.

The browser stores recovery drafts, the selected local directory handle, remote offline replicas, and queued synchronization operations in IndexedDB. Standalone documents and their local preferences use browser storage. Clearing site data removes those browser-only copies and permissions, but does not delete Markdown files from a selected graph directory.

Keep regular backups before bulk renames, asset cleanup, or simultaneous editing from multiple applications. Do not treat the offline browser replica as the only backup.

## Saving and conflicts

Changes are saved automatically after a short delay. Before writing to the filesystem, notd stores a recovery draft in IndexedDB.

Possible states include:

- **Modified**;
- **Saving…**;
- **Saved**;
- **Conflict**;
- **Save failed**.

If a file changes externally while local edits are pending, notd does not overwrite it automatically. A manual save lets the user explicitly choose whether to replace the disk version.

## LAN synchronization

When running through `server.py`:

- saves are announced to connected browsers through Server-Sent Events;
- edits made directly by other applications are detected in about one second;
- pages without pending local changes reload automatically;
- pending local changes produce a conflict instead of being overwritten;
- events contain only the path, change type, and file revision.

## Assets

Use `/upload` inside a graph block to select any file. notd stores it in the graph root’s `assets/` directory, preserves the original name when available, and inserts a Markdown link; images, audio, and video use image Markdown automatically. Audio and video references written with `![](...)` are shown as native players. Trusted iframe embeds from YouTube, Vimeo, Spotify, and SoundCloud are also rendered. If a filename already exists, notd appends `-1`, `-2`, and so on.

```markdown
![Photo](/assets/photo.png)
![Recording](../assets/recording.mp3)
![Video](../assets/video.mp4)
[Report](/assets/report.pdf)
```

Removing a link or its block does not delete the file. Run **Clean orphaned assets** from the command palette later to review and delete unreferenced uploads. The command displays the candidate filenames and requires confirmation. In LAN mode, assets are served by the graph API.

## Single-document editor

notd also works without a graph:

- `⌘/Ctrl + N`: new document;
- `⌘/Ctrl + O`: open Markdown;
- `⌘/Ctrl + S`: save;
- `⌘/Ctrl + Shift + E`: export HTML;
- `⌘/Ctrl + /`: full Markdown source;
- `⌘/Ctrl + F`: find in the document.

Direct local-file saving requires the File System Access API. Other browsers use `.md` downloads.

## Formatting

| Format | Syntax |
| --- | --- |
| Bold | `**text**` |
| Italic | `*text*` |
| Strikethrough | `~~text~~` |
| Inline code | `` `code` `` |
| Page reference | `[[page]]` |
| Block reference | `((block-id))` |
| Link | `[text](https://example.com)` |
| Image | `![alt](path)` |
| Task | `- [ ] task` |
| Quote | `> text` |
| Code block | Three backticks |

Headings, ordered lists, bullet lists, tables, dividers, frontmatter, and fenced code blocks are also supported.

To wrap selected text directly from the keyboard, type the opening character twice: `~~` creates strikethrough, `[[` creates a page reference, `((` creates a block reference, and `**` or `__` creates bold text.

## Themes

Available themes:

- Light
- Dark
- System (default), which switches automatically when the operating-system preference changes

For an open graph, the selected theme persists in `.notd/settings.json` and follows the graph across devices.

Fonts and the main colors for the light and dark themes can be customized in `theme-config.css`. This file is loaded after the application stylesheet, so its CSS variables override the defaults without requiring changes to `styles.css`.


## Privacy and security

In local mode, content is not sent to external services. In LAN mode, content is exchanged only with the configured notd server.

The LAN server:

- currently has no application authentication and is limited to trusted networks;
- rejects cross-origin browser writes and does not enable CORS;
- exposes only allowlisted application files and restricts graph access to the configured directory;
- blocks graph symlinks from bulk scans, limits uploads and note sizes, and serves unsafe attachments as downloads;
- uses atomic writes and restrictive browser security headers;
- must still use HTTPS through a reverse proxy before internet exposure.

Back up the graph regularly, especially before bulk renames or concurrent editing from multiple applications.

## Markdown compatibility

notd preserves the essential file-based graph structure: pages, journals, nested blocks, properties, page references, block references, aliases, tags, and assets. Features outside this focused Markdown workflow are not interpreted, while unknown syntax is retained whenever possible.

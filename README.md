<p align="center">
  <img src="assets/icons/notnote.svg" width="144" height="144" alt="notnote logo">
</p>

**notnote** is a minimal, private, markdown outliner. It supports standalone documents, filesystem-backed graphs, daily journals, references, tasks, attachments, offline use, and an optional server for sharing one graph across trusted devices.
<br><br>

> [!IMPORTANT]
> **Disclaimer — notnote is deliberately and strongly opinionated.**
<br>For years, I’ve used [Logseq](https://github.com/logseq/logseq) to keep track of all my ideas, tasks, activities, works, clients, and any other information worth being able to search and revisit even years later. Over time, I refined my workflow to handle a large volume of data while relying on as few plugins or extra features as possible. Recently, Logseq decided to change direction with its database version, so I figured it was time to make use of all the Markdown files I’ve accumulated over the years with a simpler tool that works exactly the way I need it to.
<br>No, I'm not kidding — you probably shouldn't use this software, unless, unfortunately for you, you happen to share the exact same mindset as me.
<br><br>


## Screenshot

![notnote journal on Towel Day](assets/screenshots/notnote.png)


## Principles

- Markdown files remain the source of truth.
- Files are stored on a local server, so you can access them from any device without managing sync.
- The interface stays quiet and exposes controls only when needed.
- Features are added for a concrete workflow rather than broad configurability.
- The application remains understandable and deployable without a JavaScript toolchain.

## Features

- Visual Markdown editing with an optional full source view.
- Standalone file opening, saving, downloading, search, outline, and HTML export.
- File-based graphs with pages, journals, nested blocks, zoom, collapse, and block selection.
- `[[page references]]`, `((block references))`, linked references, unlinked references, and page hierarchy.
- Task states, scheduled dates, task overview, and calendar navigation.
- Journal history, previous entries, and an expandable “on this day” view.
- Local attachments, images, audio, video, code blocks, quotes, tables, and common Markdown formatting.
- Command palette, customizable keyboard shortcuts, and optional Vim navigation.
- Light, dark, and system themes with a configurable accent color.
- Offline PWA support and recovery drafts.
- Optional graph server with atomic writes, conflict detection, offline queues, live updates, and configurable Git snapshots.

The complete user guide is available in [docs/user-guide.md](docs/user-guide.md) and inside the application.

## Requirements and quick start

The browser application has no package dependencies or build step. You need a current browser and any local static web server. The example below uses Python 3:

```bash
python3 -m http.server 4173
```

Open [http://localhost:4173](http://localhost:4173).

Python 3.10 or newer is required only for `server.py`. Node.js 18 or newer is required only to run the JavaScript tests. **Git is not installed or managed by notnote:** install it separately only if you want page history, automatic commits, or repository-based review. Editing, saving, synchronization, offline use, and backups all continue to work without Git.

The single-document editor works in current browsers. Direct graph access uses the File System Access API.

## Working with a local graph

Open the command palette and select **Open local graph**, then choose a directory. notnote reads Markdown files at the graph root and in `pages/` and `journals/`.

Typical outliner controls include:

- `Enter` to create a sibling block;
- `Shift+Enter` to insert a line break;
- `Tab` and `Shift+Tab` to change depth;
- `Alt+Up` and `Alt+Down` to reorder blocks;
- `Cmd/Ctrl+Enter` to cycle task states;
- a bullet click to zoom into a block;
- the arrow beside a bullet to collapse or expand its children.

See the [user guide](docs/user-guide.md) for graph navigation, commands, tasks, attachments, settings, and keyboard shortcuts.

## Sharing a graph

The included Python server can expose the application and one writable graph:

```bash
python3 server.py \
  --host 127.0.0.1 \
  --port 4176 \
  --graph /absolute/path/to/graph
```

Open [http://localhost:4176](http://localhost:4176). To use another device on a trusted LAN, bind to `0.0.0.0` and connect through the host's private address.

The graph API does not provide application-level authentication. Do not expose it directly to the public internet. Put an authenticated reverse proxy in front of it for remote access. The provided Docker configuration is designed for this model; see [docs/deployment.md](docs/deployment.md) for the Pangolin setup. Treat every authenticated user as having full read/write access to the configured graph.

## Privacy and storage

In standalone mode, document copies and preferences are stored in browser storage. In local graph mode, recovery drafts and the selected directory handle are stored in IndexedDB. Graph preferences are written to `.notnote/settings.json` inside the graph.

When the optional server is used, content is exchanged only with that server. Remote graph replicas and pending offline operations may remain in IndexedDB on each client. Markdown files always remain authoritative.

No analytics, trackers, hosted fonts, or third-party content services are included. Embedded external media may contact its original host when opened.

## Offline support

notnote installs as a Progressive Web App when served from HTTPS or localhost. The application shell is cached by the Service Worker. Server-backed graphs also keep a local replica and queue supported edits while offline, then synchronize after reconnection.

After deploying an update, close and reopen the installed application so the latest Service Worker can take control.

## Development

The project intentionally uses browser JavaScript, CSS, HTML, and the Python standard library. There is no package installation step. See [docs/architecture.md](docs/architecture.md) for data flow, trust boundaries, and file ownership.

Run the JavaScript tests with:

```bash
node --test tests/*.test.js
```

Run the server tests and syntax check with:

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m py_compile server.py
```

For a server-backed development session:

```bash
python3 server.py --port 4176 --graph /absolute/path/to/graph
```

## Project structure

```text
assets/icons/       Browser and PWA icons
assets/screenshots/ README screenshot
docker/             Container image, Compose stack, and environment template
docs/               User, architecture, and deployment documentation
tests/              Graph parser and index tests
app.js              Browser application and interface behavior
graph.js            Markdown graph parser, index, and storage adapters
index.html           Application markup
styles.css           Core interface styles
theme-config.css     Theme variables and editorial overrides
server.py            Optional writable graph server
sw.js                Offline application cache
manifest.webmanifest PWA metadata
```

The root application files are served directly. Keeping them at the root avoids generated output and makes the static deployment path identical to the source tree.

## Deployment

The static editor can be hosted on any HTTPS-capable static host. The writable graph server can run directly with Python or through the included Docker Compose configuration.

For internet access, use authentication and TLS at a reverse proxy, keep the Python service private, and back up the graph independently of the application. Detailed Docker, Pangolin, update, backup, and troubleshooting instructions are in [docs/deployment.md](docs/deployment.md).

## Scope

notnote is maintained as a focused personal tool rather than a general-purpose knowledge platform. Features that add persistent interface complexity, broad configuration surfaces, plugin systems, or hosted dependencies may be outside its intended scope.

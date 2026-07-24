#!/usr/bin/env python3
"""Serve notd and an optional writable graph over HTTP.

The graph API is intended for trusted local networks. Add application authentication
before exposing the service beyond a controlled network.
"""

from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import os
import queue
import re
import subprocess
import tempfile
import threading
import time
from collections import deque
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, quote, unquote, urlparse

MAX_BODY = 8 * 1024 * 1024
MAX_ASSET_BODY = 64 * 1024 * 1024
MAX_GRAPH_FILES = 20_000
MARKDOWN_SUFFIXES = {".md", ".markdown"}


def content_mentions_asset(content: str, path: str, decoded_content: str | None = None) -> bool:
    """Conservatively detect raw, encoded, relative, or non-standard asset mentions."""
    name = PurePosixPath(path).name
    encoded_path = "/".join(quote(part, safe="") for part in path.split("/"))
    variants = {path, encoded_path, path.replace("/", "\\"), name, quote(name, safe="")}
    decoded = unquote(content) if decoded_content is None else decoded_content
    return any(value in content for value in variants) or path in decoded or name in decoded


def referenced_asset_paths(content: str, paths: list[str]) -> set[str]:
    """Find all candidate asset names in linear time with an Aho-Corasick trie."""
    if not paths:
        return set()
    transitions: list[dict[str, int]] = [{}]
    failures = [0]
    outputs: list[list[int]] = [[]]
    for index, path in enumerate(paths):
        name = PurePosixPath(path).name
        patterns = {
            path,
            "/".join(quote(part, safe="") for part in path.split("/")),
            path.replace("/", "\\"),
            name,
            quote(name, safe=""),
        }
        for pattern in patterns:
            state = 0
            for character in pattern:
                if character not in transitions[state]:
                    transitions[state][character] = len(transitions)
                    transitions.append({})
                    failures.append(0)
                    outputs.append([])
                state = transitions[state][character]
            outputs[state].append(index)
    pending = deque(transitions[0].values())
    while pending:
        state = pending.popleft()
        for character, next_state in transitions[state].items():
            pending.append(next_state)
            fallback = failures[state]
            while fallback and character not in transitions[fallback]:
                fallback = failures[fallback]
            failures[next_state] = transitions[fallback].get(character, 0)
            outputs[next_state].extend(outputs[failures[next_state]])
    referenced: set[str] = set()
    decoded = unquote(content)
    sources = (content,) if decoded == content else (content, decoded)
    for source in sources:
        state = 0
        for character in source:
            while state and character not in transitions[state]:
                state = failures[state]
            state = transitions[state].get(character, 0)
            referenced.update(paths[index] for index in outputs[state])
    return referenced


# Serve an explicit application allowlist instead of exposing the repository root.
STATIC_FILES = {
    "/",
    "/index.html",
    "/styles.css",
    "/theme-config.css",
    "/graph.js",
    "/app.js",
    "/sw.js",
    "/manifest.webmanifest",
    "/docs/user-guide.md",
    "/docs/deployment.md",
    "/assets/icons/notd.svg",
    "/assets/icons/favicon.ico",
    "/assets/icons/favicon-16x16.png",
    "/assets/icons/favicon-32x32.png",
    "/assets/icons/apple-touch-icon.png",
    "/assets/icons/icon-192.png",
    "/assets/icons/icon-512.png",
    "/assets/icons/icon-maskable-512.png",
}
SAFE_INLINE_ASSET_TYPES = {
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
    "audio/mpeg", "audio/mp4", "audio/mp4a-latm", "audio/ogg", "audio/wav", "audio/x-wav",
    "audio/aac", "audio/x-aac", "audio/flac", "audio/x-flac",
    "video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-m4v",
}


class EventBroker:
    """Fan graph-change events out to bounded per-client queues."""

    def __init__(self) -> None:
        self._subscribers: set[queue.Queue] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        subscriber: queue.Queue = queue.Queue(maxsize=100)
        with self._lock:
            self._subscribers.add(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)

    def publish(self, event: dict) -> None:
        event["timestamp"] = time.time()
        with self._lock:
            subscribers = list(self._subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                try:
                    subscriber.get_nowait()
                    subscriber.put_nowait(event)
                except (queue.Empty, queue.Full):
                    pass


class GraphWatcher(threading.Thread):
    """Poll graph metadata and publish only path and revision changes."""

    def __init__(self, graph: Path, broker: EventBroker, on_change=None) -> None:
        super().__init__(name="notd-graph-watcher", daemon=True)
        self.graph = graph
        self.broker = broker
        self.on_change = on_change
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.snapshot = self._scan()

    def _scan(self) -> dict[str, str]:
        result: dict[str, str] = {}
        candidates = [path for path in self.graph.iterdir() if path.is_file() and not path.is_symlink() and path.suffix.lower() in MARKDOWN_SUFFIXES]
        for folder_name in ("pages", "journals"):
            folder = self.graph / folder_name
            if folder.is_dir():
                candidates.extend(
                    path for path in folder.rglob("*")
                    if path.is_file()
                    and not path.is_symlink()
                    and path.suffix.lower() in MARKDOWN_SUFFIXES
                    and path.relative_to(folder).parts[0].lower() != folder_name
                )
        for path in candidates:
            try:
                result[path.relative_to(self.graph).as_posix()] = str(path.stat().st_mtime_ns)
            except OSError:
                pass
        return result

    def run(self) -> None:
        while True:
            # Keep small graphs responsive without continuously walking very large ones.
            interval = min(5.0, 0.75 + len(self.snapshot) / 5_000)
            if self.stopped.wait(interval):
                return
            with self.lock:
                current = self._scan()
                previous = self.snapshot
                self.snapshot = current
            changed = False
            for path, revision in current.items():
                if path not in previous:
                    changed = True
                    self.broker.publish({"type": "created", "path": path, "revision": revision})
                elif previous[path] != revision:
                    changed = True
                    self.broker.publish({"type": "changed", "path": path, "revision": revision})
            for path in previous.keys() - current.keys():
                changed = True
                self.broker.publish({"type": "deleted", "path": path})
            if changed and self.on_change:
                self.on_change()

    def stop(self) -> None:
        self.stopped.set()


class GitSyncManager:
    """Create debounced Git snapshots for a graph and optionally push them."""

    def __init__(self, graph: Path, mutation_lock: threading.Lock) -> None:
        self.graph = graph
        self.mutation_lock = mutation_lock
        self.state_lock = threading.Lock()
        self.operation_lock = threading.Lock()
        self.timer: threading.Timer | None = None
        self.pending = False
        self.running = False
        self.last_action = ""
        self.last_error = ""
        self.last_synced_at = 0.0

    def _run(self, arguments: list[str], root: Path | None = None, timeout: int = 20) -> subprocess.CompletedProcess:
        environment = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        return subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-C", str(root or self.graph), *arguments],
            capture_output=True, text=True, timeout=timeout, check=False, env=environment,
        )

    def _context(self) -> tuple[Path, str, str, str]:
        repository = self._run(["rev-parse", "--show-toplevel"])
        if repository.returncode:
            raise ValueError("The graph is not inside a Git repository")
        root = Path(repository.stdout.strip()).resolve()
        try:
            graph_path = self.graph.relative_to(root).as_posix() or "."
        except ValueError as error:
            raise ValueError("The graph is outside the Git repository") from error
        branch_result = self._run(["branch", "--show-current"], root)
        branch = branch_result.stdout.strip() if branch_result.returncode == 0 else ""
        upstream_result = self._run(
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root
        )
        upstream = upstream_result.stdout.strip() if upstream_result.returncode == 0 else ""
        return root, graph_path, branch, upstream

    def _settings(self) -> dict:
        try:
            settings = json.loads((self.graph / ".notd" / "settings.json").read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return {}
        value = settings.get("gitSync", {}) if isinstance(settings, dict) else {}
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _delay(settings: dict) -> int:
        try:
            value = int(settings.get("debounceSeconds", 10) or 10)
        except (TypeError, ValueError):
            value = 10
        return max(2, min(300, value))

    def status(self) -> dict:
        settings = self._settings()
        try:
            _, _, branch, upstream = self._context()
            available = True
            message = "Git repository ready"
        except (ValueError, OSError, subprocess.TimeoutExpired) as error:
            available = False
            branch = ""
            upstream = ""
            message = str(error)
        with self.state_lock:
            return {
                "available": available,
                "message": message,
                "branch": branch,
                "upstream": upstream,
                "autoCommit": bool(settings.get("autoCommit", False)),
                "autoPush": bool(settings.get("autoPush", False)),
                "debounceSeconds": self._delay(settings),
                "pending": self.pending,
                "running": self.running,
                "lastAction": self.last_action,
                "lastError": self.last_error,
                "lastSyncedAt": round(self.last_synced_at * 1000),
            }

    def schedule(self) -> None:
        settings = self._settings()
        if not settings.get("autoCommit"):
            return
        delay = self._delay(settings)
        with self.state_lock:
            if self.timer:
                self.timer.cancel()
            self.pending = True
            self.timer = threading.Timer(delay, self.sync)
            self.timer.daemon = True
            self.timer.start()

    @staticmethod
    def _change_label(path: str, graph_path: str) -> str:
        relative = PurePosixPath(path)
        if graph_path != ".":
            try:
                relative = relative.relative_to(PurePosixPath(graph_path))
            except ValueError:
                pass
        parts = relative.parts
        value = relative.as_posix()
        if value == ".notd/settings.json":
            return "graph settings"
        if parts and parts[0] == "assets":
            return f"asset {'/'.join(parts[1:])}"
        if parts and parts[0] == "journals":
            stem = PurePosixPath("/".join(parts[1:])).with_suffix("").as_posix()
            date = stem.replace("_", "-") if re.fullmatch(r"\d{4}_\d{2}_\d{2}", stem) else stem
            return f"journal {unquote(date)}"
        if parts and parts[0] == "pages":
            value = "/".join(parts[1:])
        if PurePosixPath(value).suffix.lower() in MARKDOWN_SUFFIXES:
            value = str(PurePosixPath(value).with_suffix(""))
        return unquote(value.replace("___", "/"))

    @classmethod
    def _commit_message(cls, name_status: str, graph_path: str) -> str:
        values = name_status.split("\0")
        changes: list[tuple[str, str, str | None]] = []
        index = 0
        while index < len(values) and values[index]:
            status = values[index]
            index += 1
            if status.startswith("R") or status.startswith("C"):
                if index + 1 >= len(values):
                    break
                source, target = values[index], values[index + 1]
                index += 2
                changes.append(("Rename", cls._change_label(source, graph_path), cls._change_label(target, graph_path)))
            else:
                if index >= len(values):
                    break
                path = values[index]
                index += 1
                verb = {"A": "Add", "D": "Delete", "M": "Update"}.get(status[:1], "Update")
                changes.append((verb, cls._change_label(path, graph_path), None))
        if not changes:
            return "Update graph"
        same_action = len({change[0] for change in changes}) == 1 and all(
            target is None for _, _, target in changes
        )
        if same_action and len(changes) <= 3:
            verb = changes[0][0]
            labels = [label for _, label, _ in changes]
            if len(labels) == 1:
                message = f"{verb} {labels[0]}"
            elif len(labels) == 2:
                message = f"{verb} {labels[0]} and {labels[1]}"
            else:
                message = f"{verb} {labels[0]}, {labels[1]}, and {labels[2]}"
        else:
            phrases = []
            for position, (verb, label, target) in enumerate(changes[:3]):
                action = verb if position == 0 else verb.lower()
                phrases.append(f"{action} {label}{f' to {target}' if target else ''}")
            if len(changes) > 3:
                phrases = phrases[:2] + [f"{len(changes) - 2} more"]
            if len(phrases) == 1:
                message = phrases[0]
            elif len(phrases) == 2:
                message = " and ".join(phrases)
            else:
                message = f"{', '.join(phrases[:-1])}, and {phrases[-1]}"
        if len(message) <= 72:
            return message
        verbs = {change[0] for change in changes}
        verb = verbs.pop() if len(verbs) == 1 else "Change"
        return f"{verb} {len(changes)} graph files"

    def sync(self, push: bool | None = None) -> dict:
        if not self.operation_lock.acquire(blocking=False):
            with self.state_lock:
                self.pending = True
                self.timer = threading.Timer(2, self.sync)
                self.timer.daemon = True
                self.timer.start()
            return self.status()
        with self.state_lock:
            if self.timer:
                self.timer.cancel()
                self.timer = None
            self.pending = False
            self.running = True
            self.last_error = ""
        try:
            settings = self._settings()
            should_push = bool(settings.get("autoPush", False)) if push is None else bool(push)
            root, graph_path, _, upstream = self._context()
            with self.mutation_lock:
                added = self._run(["add", "--all", "--", graph_path], root)
                if added.returncode:
                    raise ValueError(added.stderr.strip() or "Could not stage graph changes")
                changed = self._run(["diff", "--cached", "--quiet", "--", graph_path], root)
                if changed.returncode not in {0, 1}:
                    raise ValueError(changed.stderr.strip() or "Could not inspect staged changes")
                committed = changed.returncode == 1
                if committed:
                    summary = self._run(
                        ["diff", "--cached", "--name-status", "--find-renames", "-z", "--", graph_path], root
                    )
                    if summary.returncode:
                        raise ValueError(summary.stderr.strip() or "Could not summarize staged changes")
                    message = self._commit_message(summary.stdout, graph_path)
                    commit = self._run(["commit", "-m", message, "--", graph_path], root)
                    if commit.returncode:
                        raise ValueError(commit.stderr.strip() or "Could not commit graph changes")
            action = "Graph committed" if committed else "No changes to commit"
            if should_push:
                if not upstream:
                    raise ValueError("The current branch has no upstream remote")
                pushed = self._run(["push"], root, timeout=60)
                if pushed.returncode:
                    raise ValueError(pushed.stderr.strip() or "Could not push graph changes")
                action = "Graph committed and pushed" if committed else "Remote already up to date"
            with self.state_lock:
                self.last_action = action
                self.last_synced_at = time.time()
        except (ValueError, OSError, subprocess.TimeoutExpired) as error:
            with self.state_lock:
                self.last_error = str(error)
                self.last_action = "Git sync failed"
        finally:
            with self.state_lock:
                self.running = False
            self.operation_lock.release()
        return self.status()

    def stop(self) -> None:
        with self.state_lock:
            if self.timer:
                self.timer.cancel()
                self.timer = None


def journal_config(graph: Path) -> dict[str, str]:
    """Read supported legacy journal tokens while keeping defaults on failure."""
    defaults = {"fileNameFormat": "yyyy_MM_dd", "pageTitleFormat": "MMM do, yyyy"}
    try:
        content = (graph / "logseq" / "config.edn").read_text(encoding="utf-8")
    except OSError:
        return defaults
    page = re.search(r':journal/page-title-format\s+"([^"]+)"', content)
    filename = re.search(r':journal/file-name-format\s+"([^"]+)"', content)
    return {
        "fileNameFormat": filename.group(1) if filename else defaults["fileNameFormat"],
        "pageTitleFormat": page.group(1) if page else defaults["pageTitleFormat"],
    }


class NotdHandler(SimpleHTTPRequestHandler):
    """Serve the static shell and a same-origin, graph-scoped JSON API."""

    server_version = "notd/1"
    protocol_version = "HTTP/1.1"

    @property
    def graph(self) -> Path | None:
        return self.server.graph  # type: ignore[attr-defined]

    @property
    def broker(self) -> EventBroker:
        return self.server.broker  # type: ignore[attr-defined]

    @property
    def watcher(self) -> GraphWatcher | None:
        return self.server.watcher  # type: ignore[attr-defined]

    @property
    def git_sync(self) -> GitSyncManager | None:
        return self.server.git_sync  # type: ignore[attr-defined]

    def end_headers(self) -> None:
        route = urlparse(self.path).path
        if route.startswith("/api/") or route.startswith("/assets/"):
            self.send_header("Cache-Control", "no-store")
        elif route in {"/", "/index.html", "/sw.js"}:
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https: http:; media-src 'self' blob: https: http:; frame-src https://youtu.be https://youtube.com https://*.youtube.com https://youtube-nocookie.com https://*.youtube-nocookie.com https://player.vimeo.com https://open.spotify.com https://w.soundcloud.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
        super().end_headers()

    def valid_write_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return parsed.scheme in {"http", "https"} and parsed.netloc == self.headers.get("Host", "")

    def require_api_access(self, parsed, write: bool = False) -> bool:
        if write and not self.valid_write_origin():
            self.error_json(HTTPStatus.FORBIDDEN, "Invalid request origin")
            return False
        return True

    def send_head(self):
        """Serve only public application files and the SPA shell."""
        original_path = self.path
        route = urlparse(original_path).path
        if re.match(r"^/(?:pages|journals)/[^/].*", route):
            route = "/index.html"
        if route not in STATIC_FILES:
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        self.path = route
        try:
            return super().send_head()
        finally:
            self.path = original_path

    def json_response(self, payload: object, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        compressed = len(body) >= 1024 and "gzip" in self.headers.get("Accept-Encoding", "").lower()
        if compressed:
            body = gzip.compress(body, compresslevel=4)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, status: int, message: str) -> None:
        # A rejected request may still have an unread body; do not reuse that HTTP/1.1
        # connection or the remaining bytes could be parsed as a second request.
        self.close_connection = True
        self.json_response({"error": message}, status)

    def graph_path(self, raw_path: str, markdown_only: bool = False) -> Path:
        """Resolve an API path beneath the graph root and reject symlink escapes."""
        if not self.graph:
            raise FileNotFoundError("No graph configured")
        relative = PurePosixPath(unquote(raw_path))
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValueError("Invalid graph path")
        target = (self.graph / Path(*relative.parts)).resolve()
        target.relative_to(self.graph)
        if markdown_only and target.suffix.lower() not in MARKDOWN_SUFFIXES:
            raise ValueError("Only Markdown files can be modified")
        return target

    def graph_asset_path(self, raw_path: str) -> Path:
        relative = PurePosixPath(unquote(raw_path))
        if len(relative.parts) < 2 or relative.parts[0] != "assets":
            raise ValueError("Assets must be stored in assets/")
        target = self.graph_path(relative.as_posix())
        assert self.graph
        target.relative_to((self.graph / "assets").resolve())
        return target

    def send_asset(self, target: Path) -> None:
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        inline = content_type in SAFE_INLINE_ASSET_TYPES
        size = target.stat().st_size
        start, end = 0, max(0, size - 1)
        byte_range = self.headers.get("Range", "")
        partial = False
        if byte_range:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", byte_range.strip())
            if not match or (not match.group(1) and not match.group(2)):
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            if match.group(1):
                start = int(match.group(1)); end = min(int(match.group(2) or end), end)
            else:
                suffix = int(match.group(2)); start = max(0, size - suffix)
            if start >= size or start > end:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            partial = True
        length = end - start + 1 if size else 0
        self.send_response(HTTPStatus.PARTIAL_CONTENT if partial else HTTPStatus.OK)
        self.send_header("Content-Type", content_type if inline else "application/octet-stream")
        self.send_header("Content-Disposition", "inline" if inline else f"attachment; filename={json.dumps(target.name)}")
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with target.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def git_context(self, target: Path) -> tuple[Path | None, str | None, str | None]:
        try:
            repository = subprocess.run(
                ["git", "-C", str(self.graph), "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, timeout=5, check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None, None, "Git is not available on the server"
        if repository.returncode:
            return None, None, "The graph is not inside a Git repository"
        repository_root = Path(repository.stdout.strip()).resolve()
        try:
            repository_path = target.resolve().relative_to(repository_root).as_posix()
        except ValueError:
            return None, None, "The page is outside the Git repository"
        return repository_root, repository_path, None

    def git_file_content(
        self,
        repository_root: Path,
        commit: str,
        relative: PurePosixPath,
    ) -> str:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(repository_root),
                "show",
                f"{commit}:{relative.as_posix()}",
            ],
            capture_output=True,
            timeout=10,
            check=False,
        )
        if result.returncode:
            error = result.stderr.decode("utf-8", errors="replace").strip()
            raise ValueError(error or "Could not read historical page")
        if len(result.stdout) > MAX_BODY:
            raise ValueError("Historical page is too large")
        return result.stdout.decode("utf-8")

    def request_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid request size") from error
        if length <= 0 or length > MAX_BODY:
            raise ValueError("Invalid request size")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        return payload

    def scan_graph(self) -> list[dict]:
        """Return bounded note metadata and content for initial client indexing."""
        assert self.graph
        candidates: list[Path] = []
        candidates.extend(path for path in self.graph.iterdir() if path.is_file() and not path.is_symlink() and path.suffix.lower() in MARKDOWN_SUFFIXES)
        for folder_name in ("pages", "journals"):
            folder = self.graph / folder_name
            if folder.is_dir():
                candidates.extend(
                    path for path in folder.rglob("*")
                    if path.is_file()
                    and not path.is_symlink()
                    and path.suffix.lower() in MARKDOWN_SUFFIXES
                    and path.relative_to(folder).parts[0].lower() != folder_name
                )
        unique = sorted(set(candidates))
        if len(unique) > MAX_GRAPH_FILES:
            raise ValueError(f"Graph contains more than {MAX_GRAPH_FILES} Markdown files")
        files = []
        cache = self.server.file_cache  # type: ignore[attr-defined]
        cache_lock = self.server.file_cache_lock  # type: ignore[attr-defined]
        active_keys = set()
        for path in unique:
            try:
                stat = path.stat()
                if stat.st_size > MAX_BODY:
                    continue
                relative = path.relative_to(self.graph).as_posix()
                key = (relative, stat.st_mtime_ns, stat.st_size)
                active_keys.add(key)
                with cache_lock:
                    content = cache.get(key)
                if content is None:
                    content = path.read_text(encoding="utf-8")
                    with cache_lock:
                        cache[key] = content
                files.append({
                    "path": relative, "name": path.name,
                    "folder": path.parent.relative_to(self.graph).as_posix() if path.parent != self.graph else "",
                    "content": content, "revision": str(stat.st_mtime_ns),
                })
            except (OSError, UnicodeError):
                continue
        with cache_lock:
            for key in cache.keys() - active_keys:
                cache.pop(key, None)
        return files

    def stream_events(self) -> None:
        subscriber = self.broker.subscribe()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = subscriber.get(timeout=15)
                    payload = json.dumps(event, ensure_ascii=False).encode("utf-8")
                    self.wfile.write(b"data: " + payload + b"\n\n")
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.broker.unsubscribe(subscriber)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if (parsed.path.startswith("/assets/") or parsed.path.startswith("/api/graph")) and not self.require_api_access(parsed):
            return
        if parsed.path.startswith("/assets/") and parsed.path not in STATIC_FILES and self.graph:
            try:
                target = self.graph_asset_path(parsed.path.lstrip("/"))
                if not target.is_file():
                    raise FileNotFoundError(parsed.path)
                self.send_asset(target)
                return
            except (ValueError, OSError):
                return self.error_json(HTTPStatus.NOT_FOUND, "Asset not found")
        if not parsed.path.startswith("/api/graph"):
            return super().do_GET()
        if not self.graph:
            return self.error_json(HTTPStatus.NOT_FOUND, "No graph configured")
        try:
            if parsed.path == "/api/graph/events":
                return self.stream_events()
            if parsed.path == "/api/graph/status":
                return self.json_response({"enabled": True, "name": self.graph.name, "config": journal_config(self.graph)})
            if parsed.path == "/api/graph/git/status":
                if not self.git_sync:
                    return self.json_response({"available": False, "message": "Git sync is unavailable"})
                return self.json_response(self.git_sync.status())
            if parsed.path == "/api/graph/settings":
                target = self.graph / ".notd" / "settings.json"
                if not target.is_file():
                    raise FileNotFoundError("settings.json")
                settings = json.loads(target.read_text(encoding="utf-8"))
                if not isinstance(settings, dict):
                    raise ValueError("Graph settings must be a JSON object")
                return self.json_response(settings)
            if parsed.path == "/api/graph/stats":
                files = 0
                size = 0
                last_modified = 0.0
                skipped = 0
                for root, _, names in os.walk(self.graph, onerror=lambda _: None):
                    for name in names:
                        try:
                            candidate = Path(root) / name
                            if candidate.is_symlink():
                                skipped += 1
                                continue
                            stat = candidate.stat()
                        except OSError:
                            skipped += 1
                            continue
                        files += 1
                        size += stat.st_size
                        last_modified = max(last_modified, stat.st_mtime)
                return self.json_response({"files": files, "size": size, "lastModified": round(last_modified * 1000), "partial": skipped > 0})
            if parsed.path == "/api/graph/files":
                return self.json_response({"files": self.scan_graph(), "config": journal_config(self.graph)})
            if parsed.path == "/api/graph/assets":
                root = self.graph / "assets"
                files = [path.relative_to(self.graph).as_posix() for path in root.rglob("*") if path.is_file() and not path.is_symlink()] if root.is_dir() else []
                return self.json_response({"files": sorted(files)})
            query = parse_qs(parsed.query)
            raw_path = query.get("path", [""])[0]
            if parsed.path == "/api/graph/file":
                target = self.graph_path(raw_path, markdown_only=True)
                stat = target.stat()
                return self.json_response({"path": raw_path, "content": target.read_text(encoding="utf-8"), "revision": str(stat.st_mtime_ns)})
            if parsed.path == "/api/graph/history":
                target = self.graph_path(raw_path, markdown_only=True)
                if not target.is_file():
                    raise FileNotFoundError(raw_path)
                repository_root, repository_path, message = self.git_context(target)
                if not repository_root or not repository_path:
                    return self.json_response({"available": False, "dirty": False, "commits": [], "message": message})
                history = subprocess.run(
                    ["git", "-C", str(repository_root), "log", "--follow", "-n", "100", "--date=iso-strict", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s", "--name-only", "--", repository_path],
                    capture_output=True, text=True, timeout=10, check=False,
                )
                status = subprocess.run(
                    ["git", "-C", str(repository_root), "status", "--porcelain=v1", "--", repository_path],
                    capture_output=True, text=True, timeout=5, check=False,
                )
                if history.returncode:
                    raise ValueError(history.stderr.strip() or "Could not read Git history")
                commits = []
                for record in history.stdout.split("\x1e"):
                    fields = record.strip("\r\n").split("\x1f", 3)
                    if len(fields) != 4:
                        continue
                    subject_and_paths = fields[3].splitlines()
                    subject = subject_and_paths[0] if subject_and_paths else ""
                    changed_paths = [path.strip() for path in subject_and_paths[1:] if path.strip()]
                    commits.append({"hash": fields[0], "author": fields[1], "date": fields[2], "subject": subject, "gitPath": changed_paths[-1] if changed_paths else repository_path})
                return self.json_response({"available": True, "dirty": bool(status.stdout.strip()), "commits": commits, "path": repository_path})
            if parsed.path == "/api/graph/history/diff":
                target = self.graph_path(raw_path, markdown_only=True)
                if not target.is_file():
                    raise FileNotFoundError(raw_path)
                repository_root, repository_path, message = self.git_context(target)
                if not repository_root or not repository_path:
                    return self.json_response({"available": False, "diff": "", "message": message})
                commit = query.get("commit", [""])[0]
                if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", commit):
                    raise ValueError("Invalid Git commit")
                git_path = query.get("gitPath", [repository_path])[0]
                relative = PurePosixPath(git_path)
                if relative.is_absolute() or ".." in relative.parts or not relative.parts:
                    raise ValueError("Invalid historical page path")
                historical_target = (repository_root / Path(*relative.parts)).resolve()
                historical_target.relative_to(self.graph.resolve())
                if historical_target.suffix.lower() not in MARKDOWN_SUFFIXES:
                    raise ValueError("Only Markdown history can be viewed")
                result = subprocess.run(
                    ["git", "-C", str(repository_root), "show", "--format=", "--no-color", "--no-ext-diff", "--text", "--find-renames", commit, "--", relative.as_posix()],
                    capture_output=True, text=True, timeout=10, check=False,
                )
                if result.returncode:
                    raise ValueError(result.stderr.strip() or "Could not read commit diff")
                limit = 2_000_000
                truncated = len(result.stdout) > limit
                diff = result.stdout[:limit] + ("\n… diff truncated …\n" if truncated else "")
                return self.json_response({"available": True, "diff": diff, "truncated": truncated})
            if parsed.path == "/api/graph/history/content":
                target = self.graph_path(raw_path, markdown_only=True)
                if not target.is_file():
                    raise FileNotFoundError(raw_path)
                repository_root, repository_path, message = self.git_context(target)
                if not repository_root or not repository_path:
                    return self.json_response({
                        "available": False,
                        "content": "",
                        "message": message,
                    })
                commit = query.get("commit", [""])[0]
                if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", commit):
                    raise ValueError("Invalid Git commit")
                git_path = query.get("gitPath", [repository_path])[0]
                relative = PurePosixPath(git_path)
                if (
                    relative.is_absolute()
                    or ".." in relative.parts
                    or not relative.parts
                ):
                    raise ValueError("Invalid historical page path")
                historical_target = (
                    repository_root / Path(*relative.parts)
                ).resolve()
                historical_target.relative_to(self.graph.resolve())
                if historical_target.suffix.lower() not in MARKDOWN_SUFFIXES:
                    raise ValueError("Only Markdown history can be restored")
                content = self.git_file_content(repository_root, commit, relative)
                return self.json_response({"available": True, "content": content})
            if parsed.path == "/api/graph/asset":
                target = self.graph_asset_path(raw_path)
                if not target.is_file():
                    raise FileNotFoundError(raw_path)
                self.send_asset(target)
                return
            self.error_json(HTTPStatus.NOT_FOUND, "Unknown graph endpoint")
        except FileNotFoundError:
            self.error_json(HTTPStatus.NOT_FOUND, "Graph file not found")
        except (ValueError, OSError, UnicodeError, subprocess.TimeoutExpired) as error:
            self.error_json(HTTPStatus.BAD_REQUEST, str(error))

    def atomic_write(self, target: Path, content: str) -> int:
        """Flush a sibling temporary file before atomically replacing the target."""
        target.parent.mkdir(parents=True, exist_ok=True)
        mode = target.stat().st_mode & 0o777 if target.exists() else 0o644
        descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        try:
            os.chmod(temporary, mode)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        except Exception:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
        return target.stat().st_mtime_ns

    def write_markdown(self, target: Path, payload: dict) -> tuple[bool, str, int]:
        with self.server.mutation_lock:  # type: ignore[attr-defined]
            exists = target.exists()
            if not exists and not payload.get("create"):
                raise FileNotFoundError(target.name)
            expected = payload.get("expectedRevision")
            if exists and not payload.get("force") and expected is not None and target.stat().st_mtime_ns != int(expected):
                raise FileExistsError("revision conflict")
            relative = target.relative_to(self.graph).as_posix()  # type: ignore[arg-type]
            if self.watcher:
                with self.watcher.lock:
                    revision = self.atomic_write(target, str(payload.get("content", "")))
                    self.watcher.snapshot[relative] = str(revision)
            else:
                revision = self.atomic_write(target, str(payload.get("content", "")))
            return exists, relative, revision

    def write_asset(self, target: Path, content: bytes) -> Path:
        with self.server.mutation_lock:  # type: ignore[attr-defined]
            original = target; suffix = 1
            while target.exists():
                target = original.with_name(f"{original.stem}-{suffix}{original.suffix}"); suffix += 1
            target.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(content); stream.flush(); os.fsync(stream.fileno())
                os.replace(temporary, target)
            except Exception:
                try: os.unlink(temporary)
                except OSError: pass
                raise
            return target

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if not self.require_api_access(parsed, write=True):
            return
        if parsed.path == "/api/graph/settings":
            if not self.graph:
                return self.error_json(HTTPStatus.NOT_FOUND, "No graph configured")
            try:
                payload = self.request_json()
                settings = payload.get("settings")
                if not isinstance(settings, dict):
                    raise ValueError("Graph settings must be a JSON object")
                content = json.dumps(settings, ensure_ascii=False, indent=2) + "\n"
                with self.server.mutation_lock:  # type: ignore[attr-defined]
                    self.atomic_write(self.graph / ".notd" / "settings.json", content)
                self.git_sync and self.git_sync.schedule()
                return self.json_response({"saved": True})
            except (ValueError, OSError, UnicodeError, json.JSONDecodeError) as error:
                return self.error_json(HTTPStatus.BAD_REQUEST, str(error))
        if parsed.path == "/api/graph/asset":
            if not self.graph:
                return self.error_json(HTTPStatus.NOT_FOUND, "No graph configured")
            try:
                raw_path = parse_qs(parsed.query).get("path", [""])[0]
                target = self.graph_asset_path(raw_path)
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError as error:
                    raise ValueError("Invalid upload size") from error
                if length <= 0 or length > MAX_ASSET_BODY:
                    raise ValueError("Invalid upload size")
                content = self.rfile.read(length)
                if len(content) != length:
                    raise ValueError("Incomplete upload")
                target = self.write_asset(target, content)
                relative = target.relative_to(self.graph).as_posix()
                self.broker.publish({"type": "asset", "path": relative, "clientId": self.headers.get("X-Notd-Client")})
                self.git_sync and self.git_sync.schedule()
                return self.json_response({"path": relative})
            except (ValueError, OSError) as error:
                return self.error_json(HTTPStatus.BAD_REQUEST, str(error))
        if parsed.path != "/api/graph/file":
            return self.error_json(HTTPStatus.NOT_FOUND, "Unknown graph endpoint")
        try:
            payload = self.request_json()
            target = self.graph_path(str(payload.get("path", "")), markdown_only=True)
            exists, relative, revision = self.write_markdown(target, payload)
            self.broker.publish({"type": "changed" if exists else "created", "path": relative, "revision": str(revision), "clientId": payload.get("clientId")})
            self.git_sync and self.git_sync.schedule()
            self.json_response({"path": relative, "revision": str(revision)})
        except FileNotFoundError:
            self.error_json(HTTPStatus.NOT_FOUND, "Graph file not found")
        except FileExistsError:
            self.error_json(HTTPStatus.CONFLICT, "The file changed on disk")
        except (ValueError, OSError, UnicodeError, json.JSONDecodeError) as error:
            self.error_json(HTTPStatus.BAD_REQUEST, str(error))

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if not self.require_api_access(parsed, write=True):
            return
        if not self.graph:
            return self.error_json(HTTPStatus.NOT_FOUND, "No graph configured")
        if parsed.path == "/api/graph/file":
            try:
                payload = self.request_json()
                target = self.graph_path(str(payload.get("path", "")), markdown_only=True)
                with self.server.mutation_lock:  # type: ignore[attr-defined]
                    if not target.is_file():
                        raise FileNotFoundError(target.name)
                    expected = payload.get("expectedRevision")
                    if expected is not None and target.stat().st_mtime_ns != int(expected):
                        return self.error_json(HTTPStatus.CONFLICT, "The file changed on disk")
                    relative = target.relative_to(self.graph).as_posix()
                    if self.watcher:
                        with self.watcher.lock:
                            target.unlink(); self.watcher.snapshot.pop(relative, None)
                    else:
                        target.unlink()
                self.broker.publish({"type": "deleted", "path": relative, "clientId": payload.get("clientId")})
                self.git_sync and self.git_sync.schedule()
                return self.json_response({"path": relative})
            except FileNotFoundError:
                return self.error_json(HTTPStatus.NOT_FOUND, "Graph file not found")
            except (ValueError, OSError, UnicodeError, json.JSONDecodeError) as error:
                return self.error_json(HTTPStatus.BAD_REQUEST, str(error))
        if parsed.path != "/api/graph/asset":
            return self.error_json(HTTPStatus.NOT_FOUND, "Unknown graph endpoint")
        try:
            raw_path = parse_qs(parsed.query).get("path", [""])[0]
            target = self.graph_asset_path(raw_path)
            with self.server.mutation_lock:  # type: ignore[attr-defined]
                if not target.is_file():
                    raise FileNotFoundError(raw_path)
                target.unlink()
            relative = target.relative_to(self.graph).as_posix()
            self.broker.publish({"type": "asset-deleted", "path": relative, "clientId": self.headers.get("X-Notd-Client")})
            self.git_sync and self.git_sync.schedule()
            self.json_response({"path": relative})
        except FileNotFoundError:
            self.error_json(HTTPStatus.NOT_FOUND, "Asset not found")
        except (ValueError, OSError) as error:
            self.error_json(HTTPStatus.BAD_REQUEST, str(error))

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not self.require_api_access(parsed, write=True):
            return
        if parsed.path == "/api/graph/assets/cleanup":
            if not self.graph:
                return self.error_json(HTTPStatus.NOT_FOUND, "No graph configured")
            try:
                payload = self.request_json()
                raw_paths = payload.get("paths")
                if not isinstance(raw_paths, list) or len(raw_paths) > MAX_GRAPH_FILES:
                    raise ValueError("Invalid asset cleanup list")
                paths = list(dict.fromkeys(str(path) for path in raw_paths))
                targets = [(path, self.graph_asset_path(path)) for path in paths]
                deleted: list[str] = []
                referenced: list[str] = []
                missing: list[str] = []
                failed: list[str] = []
                with self.server.mutation_lock:  # type: ignore[attr-defined]
                    corpus = "\n".join(file["content"] for file in self.scan_graph())
                    linked_paths = referenced_asset_paths(corpus, paths)
                    for path, target in targets:
                        if path in linked_paths:
                            referenced.append(path)
                            continue
                        if not target.is_file():
                            missing.append(path)
                            continue
                        try:
                            target.unlink()
                            deleted.append(path)
                        except OSError:
                            failed.append(path)
                for path in deleted:
                    self.broker.publish({"type": "asset-deleted", "path": path, "clientId": payload.get("clientId")})
                if deleted and self.git_sync:
                    self.git_sync.schedule()
                return self.json_response({
                    "deleted": len(deleted),
                    "skipped": len(referenced),
                    "missing": len(missing),
                    "failed": len(failed),
                })
            except (ValueError, OSError, UnicodeError, json.JSONDecodeError) as error:
                return self.error_json(HTTPStatus.BAD_REQUEST, str(error))
        if parsed.path == "/api/graph/git/sync":
            if not self.graph or not self.git_sync:
                return self.error_json(HTTPStatus.NOT_FOUND, "Git sync is unavailable")
            try:
                payload = self.request_json()
                return self.json_response(self.git_sync.sync(push=bool(payload.get("push", False))))
            except (ValueError, OSError, UnicodeError, json.JSONDecodeError) as error:
                return self.error_json(HTTPStatus.BAD_REQUEST, str(error))
        if parsed.path != "/api/graph/rename":
            return self.error_json(HTTPStatus.NOT_FOUND, "Unknown graph endpoint")
        try:
            payload = self.request_json()
            source_path = str(payload.get("source", "")); target_path = str(payload.get("target", ""))
            source = self.graph_path(source_path, markdown_only=True)
            target = self.graph_path(target_path, markdown_only=True)
            path_changed = PurePosixPath(unquote(source_path)).parts != PurePosixPath(unquote(target_path)).parts
            with self.server.mutation_lock:  # type: ignore[attr-defined]
                same_entry = target.exists() and source.exists() and os.path.samefile(source, target)
                if target.exists() and path_changed and not same_entry:
                    return self.error_json(HTTPStatus.CONFLICT, "A page with this name already exists")
                expected = payload.get("expectedRevision")
                if expected is not None and source.stat().st_mtime_ns != int(expected):
                    return self.error_json(HTTPStatus.CONFLICT, "The file changed on disk")
                source_relative = source.relative_to(self.graph).as_posix()
                target_relative = PurePosixPath(unquote(target_path)).as_posix()

                def rename_file() -> int:
                    if same_entry and path_changed:
                        # A case-insensitive filesystem sees names such as test.md and
                        # Test.md as the same entry. Rename through a temporary path so
                        # the requested casing is retained without deleting the page.
                        temporary = source.with_name(f".{source.name}.case-rename-{time.time_ns()}")
                        source.replace(temporary)
                        try:
                            result = self.atomic_write(target, str(payload.get("content", "")))
                        except Exception:
                            temporary.replace(source)
                            raise
                        temporary.unlink()
                        return result
                    result = self.atomic_write(target, str(payload.get("content", "")))
                    if path_changed:
                        source.unlink()
                    return result

                if self.watcher:
                    with self.watcher.lock:
                        revision = rename_file()
                        if path_changed:
                            self.watcher.snapshot.pop(source_relative, None)
                        self.watcher.snapshot[target_relative] = str(revision)
                else:
                    revision = rename_file()
            self.broker.publish({"type": "renamed", "path": target_relative, "oldPath": source_relative, "revision": str(revision), "clientId": payload.get("clientId")})
            self.git_sync and self.git_sync.schedule()
            self.json_response({"path": target_relative, "revision": str(revision)})
        except FileNotFoundError:
            self.error_json(HTTPStatus.NOT_FOUND, "Graph file not found")
        except (ValueError, OSError, UnicodeError, json.JSONDecodeError) as error:
            self.error_json(HTTPStatus.BAD_REQUEST, str(error))


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve notd and a writable local graph")
    parser.add_argument("--host", default="127.0.0.1", help="Use 0.0.0.0 to make notd reachable on the LAN")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--graph", type=Path, help="Path to a Logseq graph exposed through the API")
    arguments = parser.parse_args()

    app_directory = Path(__file__).resolve().parent
    graph = arguments.graph.expanduser().resolve() if arguments.graph else None
    if graph and not graph.is_dir():
        parser.error(f"Graph directory does not exist: {graph}")
    def handler(*args, **kwargs):
        return NotdHandler(*args, directory=str(app_directory), **kwargs)

    server = ThreadingHTTPServer((arguments.host, arguments.port), handler)
    server.graph = graph  # type: ignore[attr-defined]
    server.broker = EventBroker()  # type: ignore[attr-defined]
    server.file_cache = {}  # type: ignore[attr-defined]
    server.file_cache_lock = threading.Lock()  # type: ignore[attr-defined]
    server.mutation_lock = threading.Lock()  # type: ignore[attr-defined]
    server.git_sync = GitSyncManager(graph, server.mutation_lock) if graph else None  # type: ignore[attr-defined]
    server.watcher = GraphWatcher(graph, server.broker, server.git_sync.schedule) if graph else None  # type: ignore[attr-defined]
    if server.watcher:
        server.watcher.start()
    location = f"http://{arguments.host}:{arguments.port}"
    print(f"notd: {location}")
    print(f"graph: {graph if graph else 'disabled'}")
    if arguments.host not in {"127.0.0.1", "localhost", "::1"} and graph:
        print("warning: the writable graph has no authentication; use only on a trusted LAN")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server.watcher:
            server.watcher.stop()
        if server.git_sync:
            server.git_sync.stop()
        server.server_close()


if __name__ == "__main__":
    main()

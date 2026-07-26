import base64
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from unittest.mock import patch

from server import (
    BOOTSTRAP_SCRIPT_HASH,
    GitSyncManager,
    NotnoteHandler,
    content_mentions_asset,
    referenced_asset_paths,
)


class StartupSecurityTests(unittest.TestCase):
    def test_inline_theme_bootstrap_matches_csp_hash(self):
        html = (Path(__file__).parents[1] / "index.html").read_text(encoding="utf-8")
        scripts = re.findall(r"<script>(.*?)</script>", html, re.DOTALL)
        self.assertEqual(len(scripts), 1)
        digest = base64.b64encode(hashlib.sha256(scripts[0].encode()).digest()).decode()
        self.assertEqual(BOOTSTRAP_SCRIPT_HASH, f"sha256-{digest}")


class GraphAssetPathTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.graph = Path(self.temporary.name).resolve()
        (self.graph / "assets" / "images").mkdir(parents=True)
        self.handler = object.__new__(NotnoteHandler)
        self.handler.server = SimpleNamespace(graph=self.graph)

    def tearDown(self):
        self.temporary.cleanup()

    def test_accepts_files_inside_assets(self):
        expected = self.graph / "assets" / "images" / "cover.png"
        self.assertEqual(
            self.handler.graph_asset_path("assets/images/cover.png"),
            expected,
        )

    def test_rejects_graph_files_outside_assets(self):
        for path in (
            ".git/config",
            "pages/private.md",
            "assets/../.git/config",
            "assets/%252e%252e/.git/config",
            "/assets/cover.png",
        ):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    self.handler.graph_asset_path(path)

    def test_rejects_asset_symlinks_to_other_graph_files(self):
        private = self.graph / ".git" / "config"
        private.parent.mkdir()
        private.write_text("private")
        link = self.graph / "assets" / "config"
        try:
            link.symlink_to(private)
        except OSError:
            self.skipTest("Symbolic links are not available")
        with self.assertRaises(ValueError):
            self.handler.graph_asset_path("assets/config")


class AssetReferenceTests(unittest.TestCase):
    def test_detects_raw_encoded_and_non_standard_asset_mentions(self):
        path = "assets/My image.png"
        self.assertTrue(content_mentions_asset("- ![](../assets/My image.png)", path))
        self.assertTrue(content_mentions_asset("- ![](../assets/My%20image.png)", path))
        content = '<img src="/assets/My%20image.png">'
        self.assertTrue(content_mentions_asset(content, path))
        self.assertEqual(
            referenced_asset_paths(content, [path, "assets/orphan.pdf"]),
            {path},
        )
        self.assertFalse(content_mentions_asset("- no attachment here", path))


class GitOptionalTests(unittest.TestCase):
    def test_reports_git_as_optional_when_executable_is_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            graph = Path(temporary).resolve()
            manager = GitSyncManager(graph, threading.Lock())
            with patch("server.subprocess.run", side_effect=FileNotFoundError("git")):
                status = manager.status()
                synced = manager.sync(push=False)
            manager.stop()

        self.assertFalse(status["available"])
        self.assertIn("git", status["message"])
        self.assertEqual(synced["lastAction"], "Git sync failed")
        self.assertIn("git", synced["lastError"])


@unittest.skipUnless(shutil.which("git"), "Git integration tests require Git")
class GitSyncManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.graph = self.root / "graph"
        (self.graph / "pages").mkdir(parents=True)
        (self.graph / ".notnote").mkdir()
        (self.graph / "pages" / "note.md").write_text("- Initial\n")
        (self.graph / ".notnote" / "settings.json").write_text(
            json.dumps({"gitSync": {"autoCommit": True, "autoPush": False, "debounceSeconds": 10}})
        )
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "notnote test")
        self.git("config", "user.email", "notnote@example.invalid")
        self.git("add", ".")
        self.git("commit", "-m", "Initial graph")
        self.manager = GitSyncManager(self.graph, threading.Lock())

    def tearDown(self):
        self.manager.stop()
        self.temporary.cleanup()

    def git(self, *arguments, directory=None):
        result = subprocess.run(
            ["git", "-C", str(directory or self.graph), *arguments],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            self.fail(result.stderr or result.stdout)
        return result.stdout.strip()

    def test_reads_page_content_from_a_previous_commit(self):
        commit = self.git("rev-parse", "HEAD")
        (self.graph / "pages" / "note.md").write_text("- Current\n")
        handler = object.__new__(NotnoteHandler)
        handler.server = SimpleNamespace(graph=self.graph)

        content = handler.git_file_content(
            self.graph,
            commit,
            PurePosixPath("pages/note.md"),
        )

        self.assertEqual(content, "- Initial\n")

    def test_commits_graph_changes_without_running_repository_hooks(self):
        marker = self.root / "hook-ran"
        hook = self.graph / ".git" / "hooks" / "post-commit"
        hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
        hook.chmod(0o755)
        (self.graph / "pages" / "note.md").write_text("- Changed\n")

        status = self.manager.sync(push=False)

        self.assertEqual(self.git("log", "-1", "--format=%s"), "Update note")
        self.assertFalse(marker.exists())
        self.assertEqual(status["lastAction"], "Graph committed")
        self.assertEqual(status["lastError"], "")

    def test_builds_descriptive_messages_for_graph_changes(self):
        cases = [
            ("M\0pages/Earth.md\0", ".", "Update Earth"),
            ("A\0journals/2026_07_22.md\0", ".", "Add journal 2026-07-22"),
            ("A\0assets/images/cover.png\0", ".", "Add asset images/cover.png"),
            ("M\0graph/.notnote/settings.json\0", "graph", "Update graph settings"),
            ("R100\0pages/Old.md\0pages/New.md\0", ".", "Rename Old to New"),
            (
                "M\0pages/Earth.md\0M\0pages/Marvin.md\0",
                ".",
                "Update Earth and Marvin",
            ),
        ]
        for status, graph_path, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(
                    self.manager._commit_message(status, graph_path),
                    expected,
                )

    def test_pushes_committed_changes_to_the_configured_upstream(self):
        remote = self.root / "remote.git"
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
        self.git("remote", "add", "origin", str(remote))
        self.git("push", "-u", "origin", "main")
        (self.graph / "pages" / "note.md").write_text("- Pushed\n")

        status = self.manager.sync(push=True)

        local_head = self.git("rev-parse", "HEAD")
        remote_head = subprocess.run(
            ["git", "--git-dir", str(remote), "rev-parse", "main"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(remote_head, local_head)
        self.assertEqual(status["lastAction"], "Graph committed and pushed")


if __name__ == "__main__":
    unittest.main()

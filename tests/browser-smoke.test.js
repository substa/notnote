// Exercise the production bundles in a real browser without adding a browser-test dependency.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function waitForJson(url, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class DevToolsClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result || {});
      } else this.events.push(message);
    };
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
  }

  call(method, params = {}) {
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
  }

  async value(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.text || "Evaluation failed");
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

test("the browser starts and installs core interactions", async (context) => {
  const chrome = chromeExecutable();
  if (!chrome || typeof WebSocket === "undefined") {
    context.skip("Chrome and WebSocket support are required");
    return;
  }

  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "notnote-chrome-"));
  const python = spawnSync("python3", ["--version"]).status === 0
    ? "python3"
    : "python";
  const server = spawn(
    python,
    ["-m", "http.server", String(appPort), "--bind", "127.0.0.1"],
    { cwd: root, stdio: "ignore" },
  );
  const browser = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let client;
  try {
    const tabs = await waitForJson(`http://127.0.0.1:${debugPort}/json`);
    const page = tabs.find((tab) => tab.type === "page");
    assert.ok(page, "Chrome did not expose a page target");
    client = new DevToolsClient(page.webSocketDebuggerUrl);
    await client.open();
    await client.call("Runtime.enable");
    await client.call("Log.enable");
    await client.call("Page.enable");
    await client.call("Page.navigate", {
      url: `http://127.0.0.1:${appPort}/`,
    });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (
        await client.value(
          'document.querySelector("#app") && !document.querySelector("#app").classList.contains("initial-loading")',
        )
      )
        break;
      await delay(100);
    }

    assert.match(
      await client.value('document.querySelector("#editor").textContent'),
      /Welcome to notnote/,
    );
    assert.deepEqual(
      await client.value(
        `performance.getEntriesByType("resource")
          .map((entry) => new URL(entry.name).pathname)
          .filter((pathname) => pathname === "/app.bundle.js" || pathname === "/app.js" || pathname === "/graph.js" || pathname.startsWith("/app/"))`,
      ),
      ["/app.bundle.js"],
    );
    assert.deepEqual(
      await client.value(
        `performance.getEntriesByType("resource")
          .map((entry) => new URL(entry.name).pathname)
          .filter((pathname) => pathname === "/app.bundle.css" || pathname === "/styles.css" || pathname === "/theme-config.css")`,
      ),
      ["/app.bundle.css"],
    );
    assert.equal(
      await client.value(
        '(() => { document.querySelector("#commandButton").click(); return document.querySelector("#commandPalette").hidden; })()',
      ),
      false,
    );

    await delay(200);
    const errors = client.events.filter((event) => {
      if (event.method === "Runtime.exceptionThrown") return true;
      const entry = event.params?.entry;
      return (
        event.method === "Log.entryAdded" &&
        entry?.level === "error" &&
        !entry.url?.endsWith("/api/graph/status")
      );
    });
    assert.deepEqual(errors, []);
  } finally {
    client?.close();
    browser.kill("SIGTERM");
    server.kill("SIGTERM");
    await delay(200);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

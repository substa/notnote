// Guard the source-module boundaries, production artifacts, and runtime allowlists.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const posix = (file) => file.split(path.sep).join("/");

function applicationFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(path.join(root, directory), {
      withFileTypes: true,
    })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(relative);
      else if (entry.name.endsWith(".js")) files.push(posix(relative));
    }
  };
  visit("app");
  return files.sort();
}

function localImports(file) {
  const source = read(file);
  const imports = [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["'];/g),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["'];/gm),
  ].map((match) => match[1]);

  return imports
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) =>
      posix(path.normalize(path.join(path.dirname(file), specifier))),
    );
}

test("the browser loads one optimized script and stylesheet", () => {
  const html = read("index.html");
  assert.match(html, /<script defer src="\/app\.bundle\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/app\.bundle\.css" \/>/);
  assert.doesNotMatch(html, /<script[^>]+src=["']\/?(?:graph\.js|app\.js|app\/)/);
  assert.doesNotMatch(html, /<link[^>]+href=["']\/?(?:styles|theme-config)\.css/);
});

test("every application module is reachable through explicit imports", () => {
  const expected = new Set(applicationFiles());
  const visited = new Set();
  const pending = ["app.js"];

  while (pending.length) {
    const file = pending.pop();
    for (const dependency of localImports(file)) {
      assert.ok(fs.existsSync(path.join(root, dependency)), dependency);
      if (!dependency.startsWith("app/") || visited.has(dependency)) continue;
      visited.add(dependency);
      pending.push(dependency);
    }
  }

  assert.deepEqual([...visited].sort(), [...expected]);
});

test("only the composition root imports event adapters", () => {
  for (const file of applicationFiles().filter(
    (name) =>
      name !== "app/composition.js" && !name.startsWith("app/events/"),
  )) {
    const eventImports = localImports(file).filter((name) =>
      name.startsWith("app/events/"),
    );
    assert.deepEqual(eventImports, [], `${file} imports an event adapter`);
  }
});

test("the application module graph remains acyclic", () => {
  const files = new Set(applicationFiles());
  const visiting = new Set();
  const visited = new Set();

  const visit = (file, path = []) => {
    if (visiting.has(file))
      assert.fail(`module cycle: ${[...path, file].join(" -> ")}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of localImports(file)) {
      if (files.has(dependency)) visit(dependency, [...path, file]);
    }
    visiting.delete(file);
    visited.add(file);
  };

  for (const file of files) visit(file);
});

test("every feature dependency contract is configured", () => {
  const contracts = new Set();
  for (const file of applicationFiles()) {
    for (const match of read(file).matchAll(
      /export function (configure[A-Za-z]+Dependencies)\(/g,
    ))
      contracts.add(match[1]);
  }
  const composition = read("app/composition.js");
  for (const name of contracts)
    assert.match(composition, new RegExp(`^  ${name}\\(\\{`, "m"), name);
  assert.ok(contracts.size > 0, "no feature dependency contracts found");
});

test("the production bundles stay within the startup budget", () => {
  const script = fs.readFileSync(path.join(root, "app.bundle.js"));
  const stylesheet = fs.readFileSync(path.join(root, "app.bundle.css"));
  const scriptGzip = gzipSync(script, { level: 4 }).byteLength;
  const stylesheetGzip = gzipSync(stylesheet, { level: 4 }).byteLength;
  assert.ok(script.byteLength < 275_000, `script is ${script.byteLength} bytes`);
  assert.ok(scriptGzip < 85_000, `script gzip is ${scriptGzip} bytes`);
  assert.ok(stylesheet.byteLength < 90_000, `CSS is ${stylesheet.byteLength} bytes`);
  assert.ok(stylesheetGzip < 20_000, `CSS gzip is ${stylesheetGzip} bytes`);
});

test("server and offline cache expose only the production bundles", () => {
  const sourceFiles = [
    "graph.js",
    "app.js",
    "styles.css",
    "theme-config.css",
    ...applicationFiles(),
  ];
  const server = read("server.py");
  const worker = read("sw.js");

  assert.match(worker, /const CACHE = "notnote-editor-[0-9a-f]{12}";/);
  for (const file of ["app.bundle.js", "app.bundle.css"]) {
    assert.ok(server.includes(`"/${file}"`), `${file} missing from server`);
    assert.ok(worker.includes(`"./${file}"`), `${file} missing from cache`);
  }
  for (const file of sourceFiles) {
    assert.ok(!server.includes(`"/${file}"`), `${file} exposed by server`);
    assert.ok(!worker.includes(`"./${file}"`), `${file} included in cache`);
  }
});

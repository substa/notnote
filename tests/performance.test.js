// Catch algorithmic regressions in indexing, search, and incremental graph updates.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { webcrypto } = require("node:crypto");

const context = { crypto: webcrypto };
context.window = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(new URL("../graph.js", `file://${__filename}`), "utf8"),
  context,
);
const Graph = context.NotnoteGraph;

// Generous limits catch algorithmic regressions without turning normal CI variance into failures.
test("large graph indexing and search stay within the regression budget", () => {
  const pages = Array.from({ length: 5000 }, (_, index) => ({
    title: `Note ${index}`,
    name: `note-${index}.md`,
    path: `pages/note-${index}.md`,
    folder: "pages",
    content: `- Content [[Note ${(index + 1) % 5000}]]\n  - TODO Task ${index}\n`,
    lastModified: index,
  }));

  let started = performance.now();
  const graphIndex = new Graph.GraphIndex(pages);
  const indexTime = performance.now() - started;

  started = performance.now();
  const results = graphIndex.search("Task 4999");
  const searchTime = performance.now() - started;

  started = performance.now();
  graphIndex.updatePage(pages[2500], "- Changed [[Note 1]]");
  const updateTime = performance.now() - started;

  assert.equal(results.length, 1);
  assert.ok(indexTime < 1500, `indexing took ${indexTime.toFixed(1)} ms`);
  assert.ok(searchTime < 500, `search took ${searchTime.toFixed(1)} ms`);
  assert.ok(updateTime < 500, `incremental update took ${updateTime.toFixed(1)} ms`);
});

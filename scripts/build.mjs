/**
 * Build the committed JavaScript and CSS artifacts and derive their Service Worker revision.
 * `--check` performs the same build in memory and fails when generated files have drifted.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const workerPath = fileURLToPath(new URL("../sw.js", import.meta.url));
const artifacts = [
  {
    name: "app.bundle.js",
    entry: "scripts/browser-entry.js",
    options: {
      format: "iife",
      banner: { js: "/* Generated file: edit graph.js, app.js, or app/ and run npm run build. */" },
    },
  },
  {
    name: "app.bundle.css",
    entry: "scripts/browser-styles.css",
    options: {
      banner: { css: "/* Generated file: edit styles.css or theme-config.css and run npm run build. */" },
    },
  },
];

for (const artifact of artifacts) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [artifact.entry],
    bundle: true,
    minify: true,
    target: ["es2022"],
    legalComments: "none",
    charset: "utf8",
    write: false,
    ...artifact.options,
  });
  artifact.output = result.outputFiles[0].contents;
  artifact.path = fileURLToPath(new URL(`../${artifact.name}`, import.meta.url));
}

// Version the critical shell from built artifacts and the files loaded before them.
const revision = createHash("sha256");
for (const { name, output } of artifacts) revision.update(name).update(output);
for (const name of ["index.html", "appearance-bootstrap.js", "manifest.webmanifest"]) {
  revision.update(name).update(await readFile(new URL(`../${name}`, import.meta.url)));
}
const cacheName = `notnote-editor-${revision.digest("hex").slice(0, 12)}`;
const worker = await readFile(workerPath, "utf8");
const cacheDeclaration = /^const CACHE = "notnote-editor-[^"]+";/m;
if (!cacheDeclaration.test(worker)) throw new Error("Service Worker cache declaration not found");
const updatedWorker = worker.replace(cacheDeclaration, `const CACHE = "${cacheName}";`);

if (check) {
  const stale = [];
  for (const artifact of artifacts) {
    const existing = await readFile(artifact.path).catch(() => null);
    if (!existing || !existing.equals(artifact.output)) stale.push(artifact.name);
  }
  if (updatedWorker !== worker) stale.push("sw.js cache revision");
  if (stale.length) {
    console.error(`${stale.join(", ")} stale; run \`npm run build\`.`);
    process.exit(1);
  }
} else {
  await Promise.all(
    artifacts.map((artifact) => writeFile(artifact.path, artifact.output)),
  );
  if (updatedWorker !== worker) await writeFile(workerPath, updatedWorker);
}

for (const artifact of artifacts) {
  const gzipBytes = gzipSync(artifact.output, { level: 4 }).byteLength;
  console.log(
    `${check ? "Verified" : "Built"} ${artifact.name} (${artifact.output.byteLength} bytes, ${gzipBytes} bytes gzip)`,
  );
}
console.log(`${check ? "Verified" : "Updated"} offline cache ${cacheName}`);

/** Producer-only clean build: remove ONLY this repository's generated dist. */
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function cleanDist() {
  if (process.argv.length !== 2) throw new Error("no cleanup arguments are accepted");

  // Never use cwd, an environment variable, or a caller-provided deletion path.
  const scripts = dirname(fileURLToPath(import.meta.url));
  const root = await realpath(resolve(scripts, ".."));
  const target = resolve(root, "dist");
  if (
    basename(scripts) !== "scripts" ||
    !root ||
    !isAbsolute(root) ||
    root === parse(root).root ||
    target === root ||
    dirname(target) !== root ||
    basename(target) !== "dist"
  ) {
    throw new Error("repository root or generated output boundary is invalid");
  }

  const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const config = JSON.parse(await readFile(resolve(root, "tsconfig.json"), "utf8"));
  if (metadata.name !== "playops" || config.compilerOptions?.outDir !== "dist") {
    throw new Error("expected PlayOps package and the exact dist compiler output");
  }

  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory() || (await realpath(target)) !== target) {
    throw new Error("dist must be the real generated directory, not a link or file");
  }
  await rm(target, { recursive: true, force: false });
}

try {
  await cleanDist();
} catch (error) {
  console.error(
    `Refusing dist cleanup: ${error instanceof Error ? error.message : "invalid cleanup prerequisites"}`,
  );
  process.exitCode = 1;
}

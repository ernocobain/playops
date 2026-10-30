/**
 * Phase 6.1 / E2-A deterministic package payload mode normalizer (Node built-ins only).
 *
 * Normalizes ONLY the approved PlayOps package payload files:
 * - Declared `package.bin` entrypoints -> exact `0755`
 * - All other compiled `dist/**\/*.js` modules, `ROOT_PAYLOAD_FILES`,
 *   `OPERATOR_DOC_FILES`, and `DEPLOYMENT_TEMPLATE_FILES` -> exact `0644`
 *
 * Validates every target before mutating any file mode.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_PACKAGE_FIELDS,
  assertPackageContents,
  assertPackageMetadata,
  DEPLOYMENT_TEMPLATE_FILES,
  findPathViolations,
  OPERATOR_DOC_FILES,
  REQUIRED_MODULE_FILES,
  ROOT_PAYLOAD_FILES,
} from "./package-content.mjs";

export const ORDINARY_FILE_MODE = 0o644;
export const EXECUTABLE_FILE_MODE = 0o755;
const PERMISSION_BITS_MASK = 0o7777;

const DEFAULT_FS_OPS = Object.freeze({
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
});

function hasControlCharacter(value) {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

/** Reject empty, control, backslash, absolute, current-dir, or parent-dir relative paths. */
export function assertSafeRelativePath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("unsafe relative path: must be a non-empty string");
  }
  if (hasControlCharacter(relPath)) {
    throw new Error(`unsafe relative path ${JSON.stringify(relPath)}: contains control characters`);
  }
  if (relPath.includes("\\")) {
    throw new Error(`unsafe relative path ${JSON.stringify(relPath)}: contains a backslash`);
  }
  if (relPath.startsWith("/") || isAbsolute(relPath) || /^[A-Za-z]:/u.test(relPath)) {
    throw new Error(`unsafe relative path ${JSON.stringify(relPath)}: must not be absolute`);
  }
  const segments = relPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(
      `unsafe relative path ${JSON.stringify(relPath)}: has empty, dot, or parent segment`,
    );
  }
  return relPath;
}

function assertVerifiedDirectory(dirPath, label, fsOps) {
  let lstat;
  try {
    lstat = fsOps.lstatSync(dirPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`missing required directory: ${label}`, { cause: error });
    }
    throw error;
  }
  if (lstat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!lstat.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0);
  const dirFd = fsOps.openSync(dirPath, openFlags);
  try {
    const fstat = fsOps.fstatSync(dirFd);
    if (fstat.isSymbolicLink() || !fstat.isDirectory()) {
      throw new Error(`${label} descriptor is not a directory`);
    }
    if (fstat.dev !== lstat.dev || fstat.ino !== lstat.ino) {
      throw new Error(`${label} directory identity changed during validation`);
    }
  } finally {
    fsOps.closeSync(dirFd);
  }
  if (fsOps.realpathSync(dirPath) !== dirPath) {
    throw new Error(`${label} must not traverse symbolic links`);
  }
}

function resolveModuleDerivedRoot(fsOps) {
  const modulePath = fileURLToPath(import.meta.url);
  const scriptsDir = dirname(modulePath);
  if (basename(scriptsDir) !== "scripts") {
    throw new Error("normalizer module must reside in the repository scripts directory");
  }
  assertVerifiedDirectory(scriptsDir, "scripts directory", fsOps);
  return resolve(scriptsDir, "..");
}

function validateRepositoryRoot(rootDir, fsOps) {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new Error("package root must be a non-empty string");
  }
  if (hasControlCharacter(rootDir) || rootDir.includes("\\") || !isAbsolute(rootDir)) {
    throw new Error("package root must be a clean absolute path");
  }
  const resolvedRoot = resolve(rootDir);
  if (resolvedRoot !== rootDir || resolvedRoot === parse(resolvedRoot).root) {
    throw new Error("package root must be a canonical non-root directory path");
  }
  assertVerifiedDirectory(resolvedRoot, "package root", fsOps);
  return resolvedRoot;
}

function validateAncestorDirectories(rootDir, relPath, fsOps) {
  assertSafeRelativePath(relPath);
  const segments = relPath.split("/");
  let currentRel = "";
  for (const segment of segments.slice(0, -1)) {
    currentRel = currentRel ? `${currentRel}/${segment}` : segment;
    const currentFull = resolve(rootDir, currentRel);
    if (relative(rootDir, currentFull) !== currentRel) {
      throw new Error(`ancestor path escaped package root: ${currentRel}`);
    }
    assertVerifiedDirectory(currentFull, `ancestor directory ${currentRel}`, fsOps);
  }
}

function acquireValidatedRegularFile(rootDir, relPath, desiredMode, openFds, fsOps) {
  assertSafeRelativePath(relPath);
  validateAncestorDirectories(rootDir, relPath, fsOps);
  const fullPath = resolve(rootDir, relPath);
  if (relative(rootDir, fullPath) !== relPath) {
    throw new Error(`target path escaped package root: ${relPath}`);
  }
  let lstat;
  try {
    lstat = fsOps.lstatSync(fullPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`missing required target: ${relPath}`, { cause: error });
    }
    throw error;
  }
  if (lstat.isSymbolicLink()) {
    throw new Error(`target must not be a symbolic link: ${relPath}`);
  }
  if (!lstat.isFile()) {
    throw new Error(`target must be a regular file: ${relPath}`);
  }
  if (lstat.nlink !== 1) {
    throw new Error(
      `target regular file must have nlink === 1 (got ${String(lstat.nlink)}): ${relPath}`,
    );
  }
  const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
  const fd = fsOps.openSync(fullPath, openFlags);
  openFds.push(fd);
  const fstat = fsOps.fstatSync(fd);
  if (fstat.isSymbolicLink() || !fstat.isFile()) {
    throw new Error(`opened descriptor is not a regular file: ${relPath}`);
  }
  if (fstat.nlink !== 1) {
    throw new Error(
      `opened descriptor must have nlink === 1 (got ${String(fstat.nlink)}): ${relPath}`,
    );
  }
  if (fstat.dev !== lstat.dev || fstat.ino !== lstat.ino) {
    throw new Error(`target identity changed during open: ${relPath}`);
  }
  if (fsOps.realpathSync(fullPath) !== fullPath) {
    throw new Error(`target path must not traverse symbolic links: ${relPath}`);
  }
  return {
    relPath,
    fullPath,
    fd,
    desiredMode,
    dev: fstat.dev,
    ino: fstat.ino,
  };
}

const DIST_BYPRODUCT_SUFFIXES = Object.freeze([".d.ts", ".js.map"]);

function classifyDistFileName(name) {
  if (name.endsWith(".js")) {
    const stem = name.slice(0, -".js".length);
    if (stem.length === 0 || stem.endsWith(".js") || stem.endsWith(".ts")) {
      return { kind: "invalid" };
    }
    return { kind: "module", stem };
  }
  for (const suffix of DIST_BYPRODUCT_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const stem = name.slice(0, -suffix.length);
      if (
        stem.length === 0 ||
        stem.endsWith(".d") ||
        stem.endsWith(".js") ||
        stem.endsWith(".ts")
      ) {
        return { kind: "invalid" };
      }
      return { kind: "byproduct", stem, suffix };
    }
  }
  return { kind: "invalid" };
}

function assertVerifiedDistByproductFile(fullPath, relPath, lstat, fsOps) {
  if (lstat.nlink !== 1) {
    throw new Error(
      `target regular file must have nlink === 1 (got ${String(lstat.nlink)}): ${relPath}`,
    );
  }
  const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
  const fd = fsOps.openSync(fullPath, openFlags);
  try {
    const fstat = fsOps.fstatSync(fd);
    if (fstat.isSymbolicLink() || !fstat.isFile()) {
      throw new Error(`opened descriptor is not a regular file: ${relPath}`);
    }
    if (fstat.nlink !== 1) {
      throw new Error(
        `opened descriptor must have nlink === 1 (got ${String(fstat.nlink)}): ${relPath}`,
      );
    }
    if (fstat.dev !== lstat.dev || fstat.ino !== lstat.ino) {
      throw new Error(`target identity changed during open: ${relPath}`);
    }
  } finally {
    fsOps.closeSync(fd);
  }
  if (fsOps.realpathSync(fullPath) !== fullPath) {
    throw new Error(`target path must not traverse symbolic links: ${relPath}`);
  }
}

function discoverCompiledDistModules(rootDir, fsOps) {
  const distFull = resolve(rootDir, "dist");
  if (dirname(distFull) !== rootDir || basename(distFull) !== "dist") {
    throw new Error("dist boundary is invalid");
  }
  assertVerifiedDirectory(distFull, "dist directory", fsOps);
  const compiledFiles = [];
  const byproductFiles = [];

  function walkDistDirectory(dirRel, dirFull) {
    const names = [...fsOps.readdirSync(dirFull)].sort();
    if (names.length === 0) {
      throw new Error(`unexpected empty directory in dist: ${dirRel}`);
    }
    for (const name of names) {
      if (typeof name !== "string" || name.length === 0 || name.startsWith(".")) {
        throw new Error(`unexpected hidden or invalid entry in dist: ${dirRel}/${String(name)}`);
      }
      const childRel = `${dirRel}/${name}`;
      assertSafeRelativePath(childRel);
      const childFull = resolve(rootDir, childRel);
      if (
        dirname(childFull) !== dirFull ||
        basename(childFull) !== name ||
        relative(rootDir, childFull) !== childRel
      ) {
        throw new Error(`dist entry escaped directory boundary: ${childRel}`);
      }
      const childStat = fsOps.lstatSync(childFull);
      if (childStat.isSymbolicLink()) {
        throw new Error(`symbolic link is not allowed in dist: ${childRel}`);
      }
      if (childStat.isDirectory()) {
        assertVerifiedDirectory(childFull, `dist directory ${childRel}`, fsOps);
        walkDistDirectory(childRel, childFull);
      } else if (childStat.isFile()) {
        const classification = classifyDistFileName(name);
        if (classification.kind === "module") {
          const violations = findPathViolations(childRel);
          if (violations.length > 0) {
            throw new Error(`unsafe dist entry ${childRel}: ${violations.join(", ")}`);
          }
          compiledFiles.push(childRel);
        } else if (classification.kind === "byproduct") {
          assertVerifiedDistByproductFile(childFull, childRel, childStat, fsOps);
          byproductFiles.push({
            childRel,
            expectedJsRel: `${dirRel}/${classification.stem}.js`,
          });
        } else {
          throw new Error(`unexpected non-JS entry in dist: ${childRel}`);
        }
      } else {
        throw new Error(`non-regular entry is not allowed in dist: ${childRel}`);
      }
    }
  }

  walkDistDirectory("dist", distFull);
  const compiledFileSet = new Set(compiledFiles);
  for (const { childRel, expectedJsRel } of byproductFiles) {
    if (!compiledFileSet.has(expectedJsRel)) {
      throw new Error(
        `unexpected non-JS entry in dist: ${childRel} (orphan without ${expectedJsRel})`,
      );
    }
  }
  return compiledFiles.sort();
}

function validateDeclaredBinPaths(metadata) {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("package metadata must be a non-null object");
  }
  const binRecord = metadata.bin;
  if (typeof binRecord !== "object" || binRecord === null || Array.isArray(binRecord)) {
    throw new Error("package.bin must be a non-null object");
  }
  const entries = Object.entries(binRecord);
  if (entries.length === 0) {
    throw new Error("package.bin must declare at least one CLI entrypoint");
  }
  const binPaths = new Set();
  for (const [binName, binTarget] of entries) {
    if (typeof binName !== "string" || binName.length === 0 || hasControlCharacter(binName)) {
      throw new Error("package.bin command name must be a valid non-empty string");
    }
    assertSafeRelativePath(binTarget);
    const violations = findPathViolations(binTarget);
    if (violations.length > 0) {
      throw new Error(
        `unsafe package.bin path ${JSON.stringify(binTarget)}: ${violations.join(", ")}`,
      );
    }
    binPaths.add(binTarget);
  }
  return binPaths;
}

function parseNormalizerOptions(options, extraArgs) {
  if (extraArgs.length > 0) {
    throw new Error("caller-controlled target lists and extra arguments are not accepted");
  }
  if (options === undefined) {
    const fsOps = DEFAULT_FS_OPS;
    return { rootDir: resolveModuleDerivedRoot(fsOps), fsOps };
  }
  if (typeof options === "string") {
    return { rootDir: options, fsOps: DEFAULT_FS_OPS };
  }
  if (typeof options === "object" && options !== null && !Array.isArray(options)) {
    for (const key of Object.keys(options)) {
      if (key !== "rootDir" && key !== "root" && key !== "fs") {
        throw new Error(`unsupported normalizer option ${JSON.stringify(key)}`);
      }
    }
    const fsOps = options.fs ? { ...DEFAULT_FS_OPS, ...options.fs } : DEFAULT_FS_OPS;
    const rawRoot = options.rootDir ?? options.root ?? resolveModuleDerivedRoot(fsOps);
    return { rootDir: rawRoot, fsOps };
  }
  throw new Error("invalid normalizer options: caller-controlled target lists are not accepted");
}

function closeAcquiredDescriptors(openFds, fsOps, throwOnCloseError) {
  const closeErrors = [];
  while (openFds.length > 0) {
    const fd = openFds.pop();
    if (fd === undefined) {
      continue;
    }
    try {
      fsOps.closeSync(fd);
    } catch (closeError) {
      closeErrors.push(closeError);
    }
  }
  if (throwOnCloseError) {
    if (closeErrors.length === 1) {
      throw closeErrors[0];
    }
    if (closeErrors.length > 1) {
      throw new AggregateError(closeErrors, "failed to close one or more file descriptors");
    }
  }
}

/**
 * Validate the PlayOps package payload contract and normalize file permissions.
 *
 * All targets are opened and validated before any `fchmodSync` call occurs.
 */
export function normalizePackageModes(options, ...extraArgs) {
  const { rootDir: rawRootDir, fsOps } = parseNormalizerOptions(options, extraArgs);
  const rootDir = validateRepositoryRoot(rawRootDir, fsOps);
  const openFds = [];

  try {
    const packageJsonTarget = acquireValidatedRegularFile(
      rootDir,
      "package.json",
      ORDINARY_FILE_MODE,
      openFds,
      fsOps,
    );

    let metadata;
    try {
      metadata = JSON.parse(fsOps.readFileSync(packageJsonTarget.fd, "utf8"));
    } catch (error) {
      throw new Error(
        `invalid package.json: ${error instanceof Error ? error.message : "parse error"}`,
        { cause: error },
      );
    }

    const declaredBinPaths = validateDeclaredBinPaths(metadata);
    assertPackageMetadata(metadata);

    const approvedBinPaths = new Set(Object.values(APPROVED_PACKAGE_FIELDS.bin));
    if (
      declaredBinPaths.size !== approvedBinPaths.size ||
      [...declaredBinPaths].some((binPath) => !approvedBinPaths.has(binPath))
    ) {
      throw new Error("package.bin entrypoints do not match the approved PlayOps contract");
    }

    const compiledDistFiles = discoverCompiledDistModules(rootDir, fsOps);
    const compiledDistSet = new Set(compiledDistFiles);

    for (const requiredModule of REQUIRED_MODULE_FILES) {
      if (!compiledDistSet.has(requiredModule)) {
        throw new Error(`missing required compiled module: ${requiredModule}`);
      }
    }
    for (const binPath of declaredBinPaths) {
      if (!compiledDistSet.has(binPath) || !REQUIRED_MODULE_FILES.includes(binPath)) {
        throw new Error(`declared package.bin entrypoint is missing from dist: ${binPath}`);
      }
    }

    const staticOrdinaryFiles = [
      ...ROOT_PAYLOAD_FILES,
      ...OPERATOR_DOC_FILES,
      ...DEPLOYMENT_TEMPLATE_FILES,
    ];
    for (const staticPath of staticOrdinaryFiles) {
      assertSafeRelativePath(staticPath);
      const violations = findPathViolations(staticPath);
      if (violations.length > 0) {
        throw new Error(`unsafe contract path ${staticPath}: ${violations.join(", ")}`);
      }
      if (declaredBinPaths.has(staticPath)) {
        throw new Error(`static payload file must not be marked executable: ${staticPath}`);
      }
    }

    const allTargetPaths = [...staticOrdinaryFiles, ...compiledDistFiles];
    assertPackageContents(allTargetPaths, metadata, compiledDistFiles);

    const acquiredTargets = [packageJsonTarget];
    for (const relPath of allTargetPaths) {
      if (relPath === "package.json") {
        continue;
      }
      const desiredMode = declaredBinPaths.has(relPath) ? EXECUTABLE_FILE_MODE : ORDINARY_FILE_MODE;
      acquiredTargets.push(
        acquireValidatedRegularFile(rootDir, relPath, desiredMode, openFds, fsOps),
      );
    }

    // Phase 2: mutate modes only after every target in the package has been validated.
    for (const target of acquiredTargets) {
      const preStat = fsOps.fstatSync(target.fd);
      if (
        preStat.isSymbolicLink() ||
        !preStat.isFile() ||
        preStat.nlink !== 1 ||
        preStat.dev !== target.dev ||
        preStat.ino !== target.ino
      ) {
        throw new Error(`target descriptor failed pre-chmod verification: ${target.relPath}`);
      }
      fsOps.fchmodSync(target.fd, target.desiredMode);
      const postStat = fsOps.fstatSync(target.fd);
      if (
        postStat.isSymbolicLink() ||
        !postStat.isFile() ||
        postStat.nlink !== 1 ||
        postStat.dev !== target.dev ||
        postStat.ino !== target.ino
      ) {
        throw new Error(`target descriptor identity changed during chmod: ${target.relPath}`);
      }
      if ((postStat.mode & PERMISSION_BITS_MASK) !== target.desiredMode) {
        throw new Error(
          `mode verification failed for ${target.relPath}: expected ${target.desiredMode.toString(8)}, got ${(postStat.mode & PERMISSION_BITS_MASK).toString(8)}`,
        );
      }
    }

    closeAcquiredDescriptors(openFds, fsOps, true);

    const executableFiles = compiledDistFiles.filter((relPath) => declaredBinPaths.has(relPath));
    const ordinaryFiles = allTargetPaths.filter((relPath) => !declaredBinPaths.has(relPath));

    return Object.freeze({
      root: rootDir,
      ordinaryFiles: Object.freeze(ordinaryFiles),
      executableFiles: Object.freeze(executableFiles),
      normalizedFiles: Object.freeze(allTargetPaths),
    });
  } finally {
    closeAcquiredDescriptors(openFds, fsOps, false);
  }
}

export function runNormalizePackageModesCli(argv = process.argv) {
  if (!Array.isArray(argv) || argv.length !== 2) {
    throw new Error("no normalization arguments are accepted");
  }
  return normalizePackageModes();
}

function isExecutedAsMain() {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  if (resolve(entry) === modulePath) {
    return true;
  }
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isExecutedAsMain()) {
  try {
    runNormalizePackageModesCli();
  } catch (error) {
    console.error(
      `Refusing package mode normalization: ${error instanceof Error ? error.message : "invalid normalization prerequisites"}`,
    );
    process.exitCode = 1;
  }
}

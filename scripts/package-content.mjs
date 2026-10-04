/**
 * Phase 6.1 packaging contract (deterministic, Node built-ins only).
 *
 * Shared by the repo's metadata test and the real-tarball acceptance harness, so
 * both judge the same rules. PlayOps ships an installed CLI, not a library API:
 * the payload is the compiled runtime JavaScript, operator-safe example
 * configuration, the release-consumer documents (`README.md`, `CHANGELOG.md`,
 * `LICENSE`) and the operator guides — never operator config, credentials, state,
 * reports, tests, source, internal plans/decision/probe docs, or development
 * output (declarations/source maps).
 */

/** Exactly the approved production dependency set (no additions, no duplicates). */
export const RUNTIME_DEPENDENCIES = Object.freeze({
  "@googleapis/androidpublisher": "^42.1.0",
  "@googleapis/playdeveloperreporting": "^15.0.1",
  "google-auth-library": "^11.1.0",
  yaml: "^2.9.1",
});

/** Only these public operator guides ship; never the entire docs/ tree. */
export const OPERATOR_DOC_FILES = Object.freeze([
  "docs/credentials.md",
  "docs/permissions-and-approvals.md",
  "docs/audit-log.md",
  "docs/release-pipeline.md",
  "docs/release-process.md",
]);

/** Root-level release-consumer files. `CHANGELOG.md` ships deliberately. */
export const ROOT_PAYLOAD_FILES = Object.freeze([
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "config/playops.example.yaml",
]);

/**
 * Exact `MAJOR.MINOR.PATCH` distribution version. The *prepared* version identity
 * (package.json == package-lock.json == newest CHANGELOG release) is enforced by
 * `scripts/release-version.mjs`, so the version is asserted here by shape plus
 * `private: true` instead of being duplicated as a literal in a second place.
 */
export const PACKAGE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

/** Approved distribution metadata. `main`/`exports`/`types` stay absent. */
export const APPROVED_PACKAGE_FIELDS = Object.freeze({
  name: "playops",
  license: "MIT",
  private: true,
  type: "module",
  engines: Object.freeze({ node: ">=24 <25" }),
  bin: Object.freeze({ playops: "dist/cli/index.js" }),
  files: Object.freeze([
    "dist/**/*.js",
    "config/playops.example.yaml",
    "CHANGELOG.md",
    ...OPERATOR_DOC_FILES,
  ]),
});

/** Lifecycle hooks that would compile or fetch on the consumer machine. */
export const FORBIDDEN_SCRIPTS = Object.freeze([
  "prepare",
  "prepublish",
  "prepublishOnly",
  "preinstall",
  "install",
  "postinstall",
  "publish",
  "postpublish",
  "version",
]);

/** Files the payload must always contain. */
export const REQUIRED_PAYLOAD_FILES = Object.freeze([...ROOT_PAYLOAD_FILES, ...OPERATOR_DOC_FILES]);

/** Compiled entry points an installation needs; also the minimum module allowlist. */
export const REQUIRED_MODULE_FILES = Object.freeze([
  "dist/index.js",
  "dist/cli/index.js",
  "dist/cli/main.js",
  "dist/audit/index.js",
  "dist/config/index.js",
  "dist/runtime/agent/index.js",
]);

export const REQUIRED_FILES = Object.freeze([...REQUIRED_PAYLOAD_FILES, ...REQUIRED_MODULE_FILES]);

const FORBIDDEN_ROOT_SEGMENTS = new Set([
  ".git",
  ".vscode",
  ".idea",
  "node_modules",
  "tests",
  "src",
  "scripts",
  "docs",
  "coverage",
  "logs",
  "data",
  "reports",
  "scratch",
  "credentials",
  "secrets",
  ".hermes",
  ".omh",
  ".omo",
  ".omx",
]);

const FORBIDDEN_EXTENSIONS = new Set([
  ".aab",
  ".apk",
  ".jsonl",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".tgz",
  ".log",
  ".ts",
  ".tsx",
]);

/** Reject unsafe or private payload paths and return plain violation strings. */
export function findPathViolations(path) {
  const violations = [];
  if (typeof path !== "string" || path.length === 0) return ["not a non-empty string"];
  // eslint-disable-next-line no-control-regex -- NUL/control bytes must never appear in a package path
  if (/[\u0000-\u001f\u007f]/u.test(path)) violations.push("contains control characters");
  if (path.includes("\\")) violations.push("contains a backslash");
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) violations.push("is absolute");
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    violations.push("has an empty, current or parent-directory segment");
  }
  const [root] = segments;
  if (root !== undefined && FORBIDDEN_ROOT_SEGMENTS.has(root)) {
    if (root !== "docs" || !OPERATOR_DOC_FILES.includes(path)) {
      violations.push(`lives under the excluded ${root}/ tree`);
    }
  }
  const basename = segments[segments.length - 1] ?? "";
  if (basename === "PLAYOPS_PLAN.md") violations.push("is the internal roadmap");
  if (basename === ".env" || basename.startsWith(".env."))
    violations.push("is an environment file");
  if (basename === ".npmrc") violations.push("is an npm registry/auth config");
  if (basename === "playops.yaml") violations.push("is operator configuration");
  if (basename === "npm-debug.log") violations.push("is an npm debug log");
  if (/\.d\.ts$/u.test(basename)) violations.push("is a TypeScript declaration");
  if (/\.js\.map$/u.test(basename)) violations.push("is a source map");
  const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")) : "";
  if (FORBIDDEN_EXTENSIONS.has(extension))
    violations.push(`uses the excluded ${extension} extension`);
  if (extension === ".json" && basename !== "package.json") {
    violations.push("is a JSON data/credential file");
  }
  return violations;
}

/** Throw unless the manifest matches the approved CLI-only distribution contract. */
export function assertPackageMetadata(metadata) {
  if (typeof metadata !== "object" || metadata === null)
    throw new Error("package metadata is missing");
  for (const [key, expected] of Object.entries(APPROVED_PACKAGE_FIELDS)) {
    const actual = metadata[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `package.${key} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  for (const key of ["main", "exports", "types"]) {
    if (metadata[key] !== undefined) {
      throw new Error(
        `package.${key} must stay absent: the installed CLI is the only supported entry`,
      );
    }
  }
  if (typeof metadata.version !== "string" || !PACKAGE_VERSION_PATTERN.test(metadata.version)) {
    throw new Error(
      `package.version must be an exact MAJOR.MINOR.PATCH release version, got ${JSON.stringify(metadata.version)}`,
    );
  }
  if (JSON.stringify(metadata.dependencies) !== JSON.stringify(RUNTIME_DEPENDENCIES)) {
    throw new Error(
      `runtime dependencies must be exactly ${JSON.stringify(RUNTIME_DEPENDENCIES)}, got ${JSON.stringify(metadata.dependencies)}`,
    );
  }
  const scripts = metadata.scripts ?? {};
  if (scripts.prepack !== "npm run build") {
    throw new Error("scripts.prepack must build the artifact before packing");
  }
  for (const hook of FORBIDDEN_SCRIPTS) {
    if (scripts[hook] !== undefined) {
      throw new Error(`scripts.${hook} must stay absent: installs must not compile or fetch`);
    }
  }
  return metadata;
}

/**
 * Throw unless the packed payload is safe. `allowedModules`, when supplied, is the
 * exact expected compiled-module set: extra or missing `dist/` entries fail.
 */
export function assertPackageContents(paths, metadata, allowedModules = null) {
  assertPackageMetadata(metadata);
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("packed payload is empty");
  const seen = new Set();
  const violations = [];
  for (const path of paths) {
    for (const violation of findPathViolations(path))
      violations.push(`${JSON.stringify(path)} ${violation}`);
    if (seen.has(path)) violations.push(`${JSON.stringify(path)} is duplicated`);
    seen.add(path);
  }
  for (const required of REQUIRED_FILES) {
    if (!seen.has(required)) violations.push(`${JSON.stringify(required)} is missing`);
  }
  if (allowedModules !== null) {
    const allowed = new Set(allowedModules);
    for (const path of paths) {
      if (path.startsWith("dist/") && !allowed.has(path)) {
        violations.push(`${JSON.stringify(path)} is not an expected compiled module`);
      }
    }
    for (const module of allowed) {
      if (!seen.has(module)) violations.push(`${JSON.stringify(module)} is missing`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`unsafe package payload:\n- ${violations.join("\n- ")}`);
  }
  return paths;
}

/** Non-throwing form for acceptance reports. */
export function evaluatePackagePayload(paths, metadata, allowedModules = null) {
  try {
    assertPackageContents(paths, metadata, allowedModules);
    return { ok: true, violations: [] };
  } catch (error) {
    return {
      ok: false,
      violations: String(error instanceof Error ? error.message : error)
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/^- /u, "")),
    };
  }
}

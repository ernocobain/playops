#!/usr/bin/env node
/**
 * Phase 6.1 artifact acceptance: real tarball, real isolated install, real bin.
 *
 * Flow (never executed from the working repository's own node_modules):
 *   isolated source copy → npm ci (dev deps) → prepack build → npm pack
 *   → payload safety assertions → separate clean consumer → production-only
 *   install of the .tgz → installed `playops` bin, offline and cwd-independent
 *   → installed-module state/audit/report/approval checks.
 *
 * Nothing here contacts Google, a model provider, or a browser: CLI children run
 * behind a generated network blocker, and every config/credential input is synthetic.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertPackageContents,
  APPROVED_PACKAGE_FIELDS,
  DEPLOYMENT_TEMPLATE_FILES,
  OPERATOR_DOC_FILES,
  ROOT_PAYLOAD_FILES,
  RUNTIME_DEPENDENCIES,
} from "./package-content.mjs";
import { assertOperatorDocumentation } from "./documentation-checks.mjs";
import { collectReleaseReport } from "./release-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = "FAKE-PHASE61-PRIVATE-MARKER";
const checks = [];
const failures = [];
const notes = [];

function check(name, condition, detail = "") {
  checks.push(name);
  if (!condition) failures.push({ name, detail });
  return Boolean(condition);
}

function run(command, args, options = {}) {
  return {
    stdout:
      execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
        ...options,
      }) ?? "",
  };
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function parsePackJson(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < 0) {
    throw new Error(`npm pack --json produced no JSON: ${stdout.slice(0, 400)}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) walk(full);
      else
        out.push(
          entry.isFile() ? rel : `${rel} (${entry.isSymbolicLink() ? "symlink" : "special"})`,
        );
    }
  };
  walk(root);
  return out.sort();
}

const traceLines = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-phase61-acceptance-"));
const source = join(base, "source");
const detached = `${source}.detached`;
const artifacts = join(base, "artifacts");
const consumer = join(base, "consumer");
const workdir = join(base, "workdir");
const stateDir = join(base, "state");
const blocker = join(base, "offline-block.mjs");
const trace = join(base, "network-trace.json");
const localSocketRoot = join(base, "s");
mkdirSync(localSocketRoot, { recursive: true });
for (const dir of [source, artifacts, consumer, workdir, stateDir])
  mkdirSync(dir, { recursive: true });

// Production host paths MUST NOT be created by any part of this acceptance run.
const hostPaths = [
  "/opt/playops",
  "/etc/playops",
  "/var/lib/playops",
  "/var/log/playops",
  "/run/playops",
];
const hostExistenceBefore = hostPaths.map((path) => existsSync(path));

const npmCli = resolve(
  dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const runtimeBin = dirname(process.execPath);
const childEnv = (extra = {}) => ({
  // Never let a real operator's PLAYOPS_* settings enter synthetic acceptance.
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLAYOPS_"))),
  PATH: `${runtimeBin}:${process.env.PATH ?? ""}`,
  NODE_ENV: "development",
  PHASE61_NET_TRACE: trace,
  ...extra,
});
const npm = (args, cwd, extra = {}) =>
  run(process.execPath, [npmCli, ...args], { cwd, env: childEnv(extra) });

writeFileSync(
  blocker,
  [
    'import http from "node:http";',
    'import https from "node:https";',
    'import net from "node:net";',
    'import dns from "node:dns";',
    'import { isAbsolute, relative, resolve } from "node:path";',
    'import { syncBuiltinESMExports } from "node:module";',
    'import { appendFileSync } from "node:fs";',
    "const record = (what) => {",
    "  try {",
    '    if (process.env.PHASE61_NET_TRACE) appendFileSync(process.env.PHASE61_NET_TRACE, what + "\\n");',
    "  } catch {}",
    '  throw new Error("NETWORK-FORBIDDEN-IN-PHASE61-ACCEPTANCE");',
    "};",
    'globalThis.fetch = () => record("fetch");',
    "http.request = () => record('http.request');",
    "https.request = () => record('https.request');",
    "const unixRoot = process.env.PHASE61_AF_UNIX_ROOT;",
    "const unixAllowed = (args) => {",
    "  const first = Array.isArray(args[0]) ? args[0][0] : args[0];",
    '  const path = typeof first === "string" ? first : first && typeof first === "object" && first.path;',
    '  if (!unixRoot || typeof path !== "string" || !isAbsolute(path)) return false;',
    '  if (first && typeof first === "object" && (first.port !== undefined || first.host !== undefined)) return false;',
    "  const rel = relative(resolve(unixRoot), resolve(path));",
    '  return rel.length > 0 && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);',
    "};",
    "const connect = net.Socket.prototype.connect;",
    "net.Socket.prototype.connect = function (...args) {",
    '  if (!unixAllowed(args)) return record("net.connect");',
    "  return connect.apply(this, args);",
    "};",
    "const listen = net.Server.prototype.listen;",
    "net.Server.prototype.listen = function (...args) {",
    '  if (!unixAllowed(args)) return record("net.listen");',
    "  return listen.apply(this, args);",
    "};",
    'http.get = () => record("http.get");',
    'https.get = () => record("https.get");',
    'globalThis[Symbol.for("playops.acceptance.local-only")] = true;',
    "for (const target of [dns, dns.promises]) {",
    "  for (const name of Object.keys(target)) {",
    '    if (/^(lookup|resolve|reverse)/u.test(name) && typeof target[name] === "function") target[name] = () => record("dns." + name);',
    "  }",
    "}",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"),
);

let tarballSha256;

try {
  // ------------------------------------------------------------- isolated source
  const tracked = run("git", ["ls-files", "-z"], { cwd: repoRoot })
    .stdout.split("\u0000")
    .filter(Boolean);
  // Include current, uncommitted implementation files without copying arbitrary
  // operator files. The tarball payload is still governed solely by npm files.
  const added = run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repoRoot })
    .stdout.split("\u0000")
    .filter(
      (path) =>
        /^(src|tests|scripts)\//u.test(path) ||
        OPERATOR_DOC_FILES.includes(path) ||
        ROOT_PAYLOAD_FILES.includes(path) ||
        DEPLOYMENT_TEMPLATE_FILES.includes(path),
    );
  for (const path of new Set([...tracked, ...added])) {
    const target = join(source, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repoRoot, path), target);
  }
  check(
    "isolated source copy excludes operator config, node_modules and dist",
    !existsSync(join(source, "config/playops.yaml")) &&
      !existsSync(join(source, "node_modules")) &&
      !existsSync(join(source, "dist")),
  );

  const seeded = {
    "config/playops.yaml": `google_play:\n  package_name: "com.example.private"\n# ${marker}\n`,
    "service-account.json": `{"type":"service_account","private_key":"${marker}"}`,
    ".env": `PLAYOPS_SECRET=${marker}`,
    "logs/playops.audit.jsonl": `{"marker":"${marker}"}`,
    "reports/playops-health-report.txt": marker,
    "data/reviews/checkpoint.json": `{"marker":"${marker}"}`,
    "app.aab": marker,
    "secret-notes.md": marker,
  };
  for (const [path, content] of Object.entries(seeded)) {
    const target = join(source, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  // --------------------------------------------------------------- ci + prepack
  npm(["ci", "--no-audit", "--no-fund"], source);
  check(
    "npm ci installed the declared dev dependencies",
    existsSync(join(source, "node_modules", "typescript", "package.json")) &&
      existsSync(join(source, "node_modules", "vitest", "package.json")),
  );
  check(
    "npm ci alone does not build dist, so prepack owns the build",
    !existsSync(join(source, "dist")),
  );

  const dryRun = parsePackJson(npm(["pack", "--dry-run", "--json"], source).stdout)[0];
  const packlist = dryRun.files.map((file) => file.path);
  const sourcePkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const expectedModules = listFiles(join(source, "dist"))
    .filter((path) => path.endsWith(".js"))
    .map((path) => `dist/${path}`);
  const packedCheck = (() => {
    try {
      assertPackageContents(packlist, sourcePkg, expectedModules);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error.message) };
    }
  })();
  check(
    "packed payload satisfies the CLI-only safety contract",
    packedCheck.ok,
    packedCheck.message ?? "",
  );
  check(
    "prepack built the documented compiled module set",
    expectedModules.length > 50 && existsSync(join(source, "dist", "cli", "index.js")),
  );
  check(
    "payload omits declarations and source maps",
    !packlist.some((path) => path.endsWith(".d.ts") || path.endsWith(".js.map")),
  );
  check(
    "payload ships the operator-safe example configuration",
    packlist.includes("config/playops.example.yaml"),
  );
  check(
    "payload excludes every seeded private path",
    Object.keys(seeded).every((path) => !packlist.includes(path)),
  );
  check(
    "payload excludes repository source, tests, dev scripts and internal docs",
    !packlist.some(
      (path) =>
        /^(src|tests|scripts)\//u.test(path) ||
        (path.startsWith("docs/") && !OPERATOR_DOC_FILES.includes(path)) ||
        path === "PLAYOPS_PLAN.md",
    ),
  );
  check(
    "payload ships the release changelog with the prepared version entry",
    packlist.includes("CHANGELOG.md") &&
      readFileSync(join(source, "CHANGELOG.md"), "utf8").includes(`## [${sourcePkg.version}]`),
  );
  const releaseReport = collectReleaseReport(source);
  check(
    "isolated copy carries one consistent prepared version (package.json == lockfile == changelog)",
    releaseReport.ok && releaseReport.version === sourcePkg.version,
    releaseReport.problems.join("; "),
  );
  check(
    "payload ships exactly the promised operator guides",
    JSON.stringify(packlist.filter((path) => path.startsWith("docs/")).sort()) ===
      JSON.stringify([...OPERATOR_DOC_FILES].sort()),
  );
  check(
    "payload ships exactly the repository-owned deployment templates",
    JSON.stringify(packlist.filter((path) => path.startsWith("deploy/")).sort()) ===
      JSON.stringify([...DEPLOYMENT_TEMPLATE_FILES].sort()),
  );

  const packed = parsePackJson(
    npm(["pack", "--json", "--pack-destination", artifacts], source).stdout,
  )[0];
  const tarball = join(artifacts, packed.filename);
  check(
    "npm pack produced a non-trivial tarball",
    existsSync(tarball) && statSync(tarball).size > 10_000,
  );
  tarballSha256 = sha256File(tarball);
  const tarListing = capture("tar", ["-tzf", tarball]);
  if (tarListing.status === 0) {
    const entries = [
      ...new Set(
        tarListing.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => line.replace(/^package\//u, "")),
      ),
    ].sort();
    check(
      "tarball listing equals the npm pack list exactly",
      JSON.stringify(entries) === JSON.stringify([...packlist].sort()),
    );
  } else {
    notes.push(
      "system tar unavailable: tarball contents cross-checked through npm's own pack list and the installed tree",
    );
  }

  // ----------------------------------------------------------- consumer install
  npm(["init", "-y"], consumer);
  check(
    "README npm init -y creates the clean consumer manifest",
    existsSync(join(consumer, "package.json")),
  );
  npm(["install", "--omit=dev", "--no-audit", "--no-fund", tarball], consumer, {
    NODE_ENV: "production",
  });
  const installed = join(consumer, "node_modules", "playops");
  check(
    "tarball installed into a clean production-only consumer",
    existsSync(join(installed, "package.json")),
  );

  const installedFiles = listFiles(installed);
  const documentation = assertOperatorDocumentation(installed);
  check(
    "installed README/changelog/operator-doc relative links and safe examples validate without repository files",
    documentation.documents.length === OPERATOR_DOC_FILES.length + 2 &&
      documentation.relativeLinks > 0,
  );
  check(
    "installed package ships the deployment templates and the deployment document",
    [...DEPLOYMENT_TEMPLATE_FILES, "docs/deployment-production.md"].every((path) =>
      installedFiles.includes(path),
    ),
  );
  const installedMetadata = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const installedCheck = (() => {
    try {
      assertPackageContents(
        installedFiles,
        { ...APPROVED_PACKAGE_FIELDS, ...installedMetadata },
        expectedModules,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error.message) };
    }
  })();
  check(
    "installed payload is exactly the approved module set",
    installedCheck.ok,
    installedCheck.message ?? "",
  );
  check(
    "installed package ships no bundled node_modules",
    !existsSync(join(installed, "node_modules")),
  );
  check(
    "production-only install pulled no dev tooling",
    !existsSync(join(consumer, "node_modules", "typescript")) &&
      !existsSync(join(consumer, "node_modules", "vitest")) &&
      !existsSync(join(consumer, "node_modules", ".bin", "tsc")),
  );
  for (const name of Object.keys(RUNTIME_DEPENDENCIES)) {
    const manifest = join(consumer, "node_modules", name, "package.json");
    check(
      `runtime dependency family ${name} resolves from the installed tree`,
      existsSync(manifest) &&
        typeof JSON.parse(readFileSync(manifest, "utf8")).version === "string",
    );
  }
  check(
    "no seeded private marker reached an installed artifact file",
    !installedFiles.some((path) => readFileSync(join(installed, path), "utf8").includes(marker)),
  );

  const binLink = join(consumer, "node_modules", ".bin", "playops");
  check("npm exposed the installed playops bin", existsSync(binLink));
  const binTarget = existsSync(binLink) ? readlinkSync(binLink) : "";
  check(
    "installed bin points at the compiled CLI",
    binTarget.replace(/\\/gu, "/").endsWith("playops/dist/cli/index.js"),
    binTarget,
  );
  check(
    "installed bin is executable",
    existsSync(binLink) && (statSync(binLink).mode & 0o111) !== 0,
  );
  const cliPath = join(installed, "dist", "cli", "index.js");
  check(
    "installed CLI keeps its shebang through build and packaging",
    readFileSync(cliPath, "utf8").startsWith("#!/usr/bin/env node"),
  );
  check(
    "installed CLI target is executable for direct invocation",
    (statSync(cliPath).mode & 0o111) !== 0,
  );

  // --------------------------------------------- offline, cwd-independent CLI
  renameSync(source, detached);
  const cliEnv = childEnv({ NODE_ENV: "production" });
  const blocked = (argsList, cwd = workdir) =>
    capture(process.execPath, ["--import", blocker, cliPath, ...argsList], { cwd, env: cliEnv });

  const help = capture(binLink, ["--help"], {
    cwd: workdir,
    env: { ...cliEnv, NODE_OPTIONS: `--import=${pathToFileURL(blocker).href}` },
  });
  check("installed bin runs from an unrelated directory and exits 0", help.status === 0);
  check("installed help remains quiet on stderr", help.stderr === "");
  check(
    "packaged runtime contains the standalone logging and shared policy modules",
    [
      "dist/logging/index.js",
      "dist/logging/context.js",
      "dist/logging/levels.js",
      "dist/shared/redaction.js",
      "dist/cli/logging.js",
    ].every((path) => installedFiles.includes(path)),
  );
  check(
    "installed bin prints the CLI usage surface",
    /Usage: playops <command>/u.test(help.stdout) &&
      /health\s+Produce a dated health comparison report/u.test(help.stdout),
  );
  check(
    "installed help output leaks no credential material",
    !/(private_key|service_account|Authorization)/iu.test(help.stdout),
  );
  check(
    "installed help lists the daemon operator-client group and pinned endpoint",
    /daemon\s+Operator client/u.test(help.stdout) &&
      /daemon status/u.test(help.stdout) &&
      /\/run\/playops\/playops\.sock/u.test(help.stdout),
  );

  // Fail the installed daemon CLI if its import graph reaches legacy authority.
  const clientImportGuard = join(consumer, "client-import-guard.mjs");
  writeFileSync(
    clientImportGuard,
    `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (["/dist/config/", "/dist/googleplay/", "/dist/doctor/", "/dist/reviews/composition", "/dist/daemon/pending-store", "/dist/daemon/request-claim", "/dist/daemon/production-composition", "/dist/releases/commit-attempt-journal", "/dist/releases/session-store", "/dist/releases/release-write-intent-store"].some((part) => result.url.includes(part))) throw new Error("CLIENT_AUTHORITY_IMPORT_FORBIDDEN");
  return result;
}});
`,
  );
  const isolatedDaemonHelp = capture(
    process.execPath,
    ["--import", blocker, "--import", clientImportGuard, cliPath, "daemon", "--help"],
    { cwd: workdir, env: cliEnv },
  );
  check(
    "installed playops daemon entrypoint imports no config, Google, stores or release composition",
    isolatedDaemonHelp.status === 0 && /off-host signer/u.test(isolatedDaemonHelp.stdout),
    isolatedDaemonHelp.stderr.slice(0, 200),
  );

  // ------------------------------------------ Stage 4B.4 operator client
  check(
    "installed daemon-client transport, approval, render and CLI modules ship in the tarball",
    [
      "dist/client/transport.js",
      "dist/client/outcome.js",
      "dist/client/approval.js",
      "dist/client/render.js",
      "dist/cli/daemon.js",
    ].every((path) => installedFiles.includes(path)),
  );
  {
    // A dist scan proves no private-key / signer API is shipped anywhere.
    const signerApi =
      /(createPrivateKey|generateKeyPair|generateKeyPairSync|createSign|privateKeyPath|createSecretKey)/u;
    const offenders = installedFiles
      .filter((path) => path.endsWith(".js"))
      .filter((path) => signerApi.test(readFileSync(join(installed, path), "utf8")));
    check(
      "no installed module exposes a private-key or signer API",
      offenders.length === 0,
      offenders.join(", "),
    );
  }

  // ------------------------------------------ Stage 4A.1 playopsd application
  const daemonBinLink = join(consumer, "node_modules", ".bin", "playopsd");
  check("npm exposed the installed playopsd bin", existsSync(daemonBinLink));
  const daemonBinTarget = existsSync(daemonBinLink) ? readlinkSync(daemonBinLink) : "";
  check(
    "installed playopsd bin points at the compiled daemon entrypoint",
    daemonBinTarget.replace(/\\/gu, "/").endsWith("playops/dist/daemon/main.js"),
    daemonBinTarget,
  );
  check(
    "installed playopsd bin is executable",
    existsSync(daemonBinLink) && (statSync(daemonBinLink).mode & 0o111) !== 0,
  );
  const daemonPath = join(installed, "dist", "daemon", "main.js");
  check(
    "installed daemon entrypoint keeps its shebang and stays executable",
    readFileSync(daemonPath, "utf8").startsWith("#!/usr/bin/env node") &&
      (statSync(daemonPath).mode & 0o111) !== 0,
  );
  const networkBefore = traceLines(trace).length;
  const daemonNoConfig = capture(process.execPath, ["--import", blocker, daemonPath], {
    cwd: workdir,
    env: cliEnv,
  });
  check(
    "playopsd without --config fails closed with a usage exit code",
    daemonNoConfig.status !== 0 && daemonNoConfig.stdout === "",
  );
  check(
    "playopsd without --config explains the missing flag and leaks nothing",
    /--config/u.test(daemonNoConfig.stderr) &&
      !/(private_key|service_account|Authorization)/iu.test(daemonNoConfig.stderr),
  );
  const daemonCliHelp = capture(process.execPath, ["--import", blocker, daemonPath, "--help"], {
    cwd: workdir,
    env: cliEnv,
  });
  check("installed playopsd --help exits 0 without any Google call", daemonCliHelp.status === 0);
  check(
    "installed playopsd --help documents the daemon CLI surface",
    /Usage: playopsd --config/u.test(daemonCliHelp.stdout) &&
      /owner-only/u.test(daemonCliHelp.stdout),
  );
  const daemonVersion = capture(process.execPath, ["--import", blocker, daemonPath, "--version"], {
    cwd: workdir,
    env: cliEnv,
  });
  check(
    "installed playopsd --version prints the packaged version and exits 0",
    daemonVersion.status === 0 && /^playopsd \d+\.\d+\.\d+\n$/u.test(daemonVersion.stdout),
    daemonVersion.stdout,
  );
  const daemonRelative = capture(
    process.execPath,
    ["--import", blocker, daemonPath, "--config", "relative/playops.yaml"],
    { cwd: workdir, env: cliEnv },
  );
  check(
    "playopsd rejects a relative --config before any daemon construction",
    daemonRelative.status !== 0 && /absolute/u.test(daemonRelative.stderr),
  );
  const daemonMissing = capture(
    process.execPath,
    ["--import", blocker, daemonPath, "--config", join(workdir, "absent-playops.yaml")],
    { cwd: workdir, env: cliEnv },
  );
  check(
    "playopsd fails closed when the explicit config file is absent",
    daemonMissing.status !== 0,
  );
  check(
    "playopsd never listens, binds a socket, or calls Google for help/version/failure paths",
    traceLines(trace).length === networkBefore && !existsSync(join(workdir, "playops.sock")),
  );

  const noConfig = blocked(["doctor"]);
  let diagnostic = null;
  try {
    diagnostic = JSON.parse(noConfig.stderr);
  } catch {
    diagnostic = null;
  }
  check(
    "installed doctor diagnostics are one safe stderr JSONL record, not stdout",
    noConfig.stderr.split("\n").filter(Boolean).length === 1 &&
      diagnostic?.level === "error" &&
      JSON.stringify(diagnostic?.context) === '{"command":"doctor","exitCode":1}' &&
      !noConfig.stdout.includes('"level"') &&
      !noConfig.stderr.includes(marker),
  );
  check(
    "installed CLI with no config fails closed at CONFIG",
    noConfig.status === 1 &&
      /CONFIG_INVALID/u.test(noConfig.stdout) &&
      /NOT READY/u.test(noConfig.stdout),
  );
  check(
    "no-config doctor skipped every later live check",
    /- CREDENTIALS/u.test(noConfig.stdout) && /- AUTH/u.test(noConfig.stdout),
  );

  const relativeConfig = join(workdir, "config", "playops.yaml");
  mkdirSync(dirname(relativeConfig), { recursive: true });
  mkdirSync(join(workdir, "creds"), { recursive: true });
  writeFileSync(join(workdir, "creds", "service-account.json"), '{"type":"not_service_account"}');
  writeFileSync(
    relativeConfig,
    'google_play:\n  package_name: "com.example.phase61"\n  service_account_json: "./creds/service-account.json"\n',
  );
  const beforeTrace = traceLines(trace).length;
  const withConfig = blocked(["doctor"]);
  check(
    "installed CLI loads cwd-relative config/playops.yaml",
    withConfig.status === 1 &&
      /✓ CONFIG/u.test(withConfig.stdout) &&
      /packageName: com\.example\.phase61/u.test(withConfig.stdout),
  );
  check(
    "cwd-relative credential path is located and read, not the install directory",
    /\[CREDENTIAL_INVALID\]/u.test(withConfig.stdout),
  );
  check(
    "credential failure precedes AUTH so no live call happens",
    /- AUTH/u.test(withConfig.stdout) && traceLines(trace).length === beforeTrace,
  );
  // Same relative credential path, different cwd: the file only exists in workdir.
  mkdirSync(join(stateDir, "config"), { recursive: true });
  writeFileSync(
    join(stateDir, "config", "playops.yaml"),
    'google_play:\n  package_name: "com.example.phase61"\n  service_account_json: "./creds/service-account.json"\n',
  );
  const otherCwd = blocked(["doctor"], stateDir);
  check(
    "the same relative config resolves differently from another cwd",
    /✓ CONFIG/u.test(otherCwd.stdout) && /\[CREDENTIAL_FILE_MISSING\]/u.test(otherCwd.stdout),
  );

  const envOverride = capture(process.execPath, ["--import", blocker, cliPath, "doctor"], {
    cwd: workdir,
    env: {
      ...cliEnv,
      PLAYOPS_GOOGLE_PLAY_PACKAGE_NAME: "com.example.phase61env",
      PLAYOPS_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "./env-missing.json",
    },
  });
  check(
    "installed CLI honours PLAYOPS_* environment overrides",
    envOverride.status === 1 &&
      /packageName: com\.example\.phase61env/u.test(envOverride.stdout) &&
      /CREDENTIAL_FILE_MISSING/u.test(envOverride.stdout),
  );

  writeFileSync(
    relativeConfig,
    'google_play:\n  package_name: "com.example.phase61"\n  service_account_json: "./creds/service-account.json"\nhealth:\n  crash_rate_threshold: 0.01\n',
  );
  const legacy = blocked(["doctor"]);
  check(
    "installed CLI rejects retired legacy threshold configuration",
    legacy.status === 1 &&
      /CONFIG_INVALID/u.test(legacy.stdout) &&
      !/✓ CONFIG/u.test(legacy.stdout),
  );
  const legacyCode = capture(
    process.execPath,
    [
      "--import",
      blocker,
      "--input-type=module",
      "-e",
      [
        `const module = await import(${JSON.stringify(pathToFileURL(join(installed, "dist", "config", "index.js")).href)});`,
        "try {",
        "  module.loadConfig();",
        '  console.log("CODE=NONE");',
        "} catch (error) {",
        '  console.log("CODE=" + (error && error.code));',
        "}",
      ].join("\n"),
    ],
    { cwd: workdir, env: cliEnv },
  );
  check(
    "installed package raises the exact CONFIG_MIGRATION_REQUIRED code",
    /CODE=CONFIG_MIGRATION_REQUIRED/u.test(legacyCode.stdout),
    legacyCode.stdout.trim(),
  );

  // ------------------------------------------------- installed-module behaviour
  writeFileSync(join(consumer, "phase61-installed-checks.mjs"), installedChecksSource());
  const moduleRun = capture(
    process.execPath,
    ["--import", blocker, join(consumer, "phase61-installed-checks.mjs")],
    {
      cwd: consumer,
      env: { ...cliEnv, PHASE61_STATE: stateDir, PHASE61_PACKAGE: installed },
    },
  );
  let moduleReport = null;
  try {
    moduleReport = JSON.parse(moduleRun.stdout.slice(moduleRun.stdout.indexOf("{")));
  } catch {
    moduleReport = null;
  }
  check(
    "installed-module acceptance produced a report",
    moduleReport !== null,
    moduleRun.stderr.slice(0, 400),
  );
  if (moduleReport) {
    for (const [name, ok] of Object.entries(moduleReport.results)) {
      check(
        `installed module behaviour: ${name}`,
        ok === true,
        JSON.stringify(moduleReport.detail?.[name] ?? ""),
      );
    }
  }

  // Negative controls use a separate trace: attempted calls are blocked BEFORE I/O.
  const guardProbeTrace = join(base, "blocked-probes.jsonl");
  const probeCode = `
import net from "node:net"; import http from "node:http"; import https from "node:https"; import dns from "node:dns";
if (globalThis[Symbol.for("playops.acceptance.local-only")] !== true) throw new Error("OFFLINE_GUARD_MISSING");
const probes = [
  ["TCP", () => net.createConnection({ host: "127.0.0.1", port: 9 })],
  ["TCP listener", () => net.createServer().listen({ host: "127.0.0.1", port: 0 })],
  ["HTTP", () => http.get("http://127.0.0.1:9")],
  ["HTTPS", () => https.get("https://127.0.0.1:9")],
  ["DNS", () => dns.lookup("synthetic.invalid", () => {})],
  ["outside Unix root", () => net.createConnection("/run/playops/playops.sock")],
  ["Unix traversal", () => net.createConnection(process.env.PHASE61_AF_UNIX_ROOT + "/../outside.sock")],
];
const blocked = [];
for (const [name, probe] of probes) {
  try { probe(); } catch (cause) { if (cause.message === "NETWORK-FORBIDDEN-IN-PHASE61-ACCEPTANCE") blocked.push(name); }
}
console.log(JSON.stringify(blocked));
if (blocked.length !== probes.length) process.exitCode = 1;
`;
  const guardProbe = capture(
    process.execPath,
    ["--import", blocker, "--input-type=module", "-e", probeCode],
    {
      cwd: consumer,
      env: { ...cliEnv, PHASE61_AF_UNIX_ROOT: localSocketRoot, PHASE61_NET_TRACE: guardProbeTrace },
    },
  );
  check(
    "offline guard blocks TCP/DNS/HTTP and Unix sockets outside the test root before I/O",
    guardProbe.status === 0 && traceLines(guardProbeTrace).length === 7,
    guardProbe.stderr.slice(0, 400),
  );

  // ---------------------- Stage 4B.4 operator client over a LOCAL test socket
  // Keep the external-network blocker active; permit only this isolated AF_UNIX
  // subtree. No TCP/DNS/HTTP exception exists for the client checks.
  writeFileSync(
    join(consumer, "phase61-daemon-client-socket.mjs"),
    daemonClientSocketChecksSource(),
  );
  const socketRun = capture(
    process.execPath,
    ["--import", blocker, join(consumer, "phase61-daemon-client-socket.mjs")],
    {
      cwd: consumer,
      env: {
        ...cliEnv,
        PHASE61_PACKAGE: installed,
        PHASE61_AF_UNIX_ROOT: localSocketRoot,
        PHASE61_BLOCKER: blocker,
      },
    },
  );
  let socketReport = null;
  try {
    socketReport = JSON.parse(socketRun.stdout.slice(socketRun.stdout.indexOf("{")));
  } catch {
    socketReport = null;
  }
  check(
    "installed daemon-client socket acceptance produced a report",
    socketReport !== null,
    socketRun.stderr.slice(0, 400),
  );
  if (socketReport) {
    for (const [name, ok] of Object.entries(socketReport.results)) {
      check(
        `installed daemon client socket: ${name}`,
        ok === true,
        JSON.stringify(socketReport.detail?.[name] ?? ""),
      );
    }
  }

  check(
    "installed local finalization and offline runtime observed zero network calls",
    traceLines(trace).length === 0,
  );
  check(
    "the acceptance run created no production host path",
    JSON.stringify(hostPaths.map((path) => existsSync(path))) ===
      JSON.stringify(hostExistenceBefore),
    hostPaths.filter((path, index) => existsSync(path) !== hostExistenceBefore[index]).join(", "),
  );
  renameSync(detached, source);

  const evidence = {
    phase: "6.1",
    compatibilityPhase: "6.2",
    artifact: {
      file: packed.filename,
      sha256: tarballSha256,
      size: packed.size,
      unpackedSize: packed.unpackedSize,
      entries: packlist.length,
      listingSource:
        tarListing.status === 0 ? "npm pack list + system tar -tzf" : "npm pack list only",
    },
    runtime: {
      node: process.version,
      execPath: process.execPath,
      npm: npm(["--version"], source).stdout.trim(),
    },
    installedBin: { link: binLink, linkTarget: binTarget, shebang: "#!/usr/bin/env node", cliPath },
    checks,
    failures,
    notes,
    networkCallsObserved: traceLines(trace),
    result: failures.length === 0 ? "PASS" : "FAIL",
    artifactDirectory: base,
  };
  writeFileSync(join(base, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  if (existsSync(detached)) renameSync(detached, source);
}

function installedChecksSource() {
  const header = [
    "/** Generated by scripts/package-acceptance.mjs; exercises the installed PlayOps modules. */",
    'import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";',
    'import { join, relative, sep } from "node:path";',
    "const state = process.env.PHASE61_STATE;",
    "const pkgDir = process.env.PHASE61_PACKAGE;",
    "const results = {};",
    "const detail = {};",
    "const record = async (name, fn) => {",
    "  try {",
    "    results[name] = (await fn()) === true;",
    "    if (results[name] !== true) detail[name] = 'returned a non-true value';",
    "  } catch (error) {",
    "    results[name] = false;",
    "    detail[name] = String(error && error.message);",
    "  }",
    "};",
    "const listing = (root) => {",
    "  const out = [];",
    "  const walk = (dir) => {",
    "    for (const entry of readdirSync(dir, { withFileTypes: true })) {",
    "      const full = join(dir, entry.name);",
    "      if (entry.isDirectory()) walk(full);",
    "      else out.push(relative(root, full).split(sep).join('/'));",
    "    }",
    "  };",
    "  walk(root);",
    "  return out.sort();",
    "};",
    "const before = listing(pkgDir);",
    "",
    'const audit = await import("playops/dist/audit/index.js");',
    'const checkpoint = await import("playops/dist/reviews/checkpoint/index.js");',
    'const sessions = await import("playops/dist/releases/session-store.js");',
    'const releases = await import("playops/dist/releases/index.js");',
    'const journal = await import("playops/dist/releases/cleanup-journal.js");',
    'const report = await import("playops/dist/health/report.js");',
    'const tools = await import("playops/dist/runtime/tools/index.js");',
    'const agent = await import("playops/dist/runtime/agent/index.js");',
    'const permissions = await import("playops/dist/runtime/permissions/index.js");',
    'const logging = await import("playops/dist/logging/index.js");',
    'const commitAttempts = await import("playops/dist/releases/commit-attempt-journal.js");',
    'const commitEvidence = await import("playops/dist/releases/commit-verification-evidence.js");',
    'const commitFinalization = await import("playops/dist/releases/finalize-verified-commit.js");',
    'const commitStatus = await import("playops/dist/releases/commit-attempt-status.js");',
    'const packageOperations = await import("playops/dist/daemon/package-operation-singleflight.js");',
    "",
  ];
  const body = [
    ...v03InstalledImportChecksSource(),
    'await record("diagnostic records redact secrets using only installed runtime modules", () => {',
    "  const lines = [];",
    '  const marker = "FAKE-PACKAGE-LOG-SECRET";',
    '  const logger = logging.createLogger({ sink: (line) => { lines.push(line); }, now: () => new Date("2026-10-03T16:00:00.000Z") });',
    '  logger.debug("Suppressed diagnostic.");',
    '  logger.info("Installed diagnostic record.", { apiKey: marker, nested: [{ authorization: marker }], error: Object.assign(new Error(marker), { status: 503, code: marker }) });',
    "  const entry = JSON.parse(lines[0]);",
    '  return lines.length === 1 && lines[0].endsWith("\\n") && !lines[0].includes(marker) && entry.level === "info" && entry.context.apiKey === "[REDACTED]" && entry.context.error.name === "Error" && entry.context.error.status === 503 && entry.context.error.code === undefined;',
    "});",
    'await record("failed diagnostic sinks do not weaken the installed durable audit writer", () => {',
    '  const logger = logging.createLogger({ sink() { throw new Error("FAKE-SINK-FAILURE"); } });',
    '  logger.error("Static diagnostic failure.");',
    '  const path = join(state, "diagnostic-sink-audit.jsonl");',
    '  const entry = audit.appendAuditEntry(path, { type: "phase62.check", actor: "system", action: "acceptance", status: "success", metadata: { secretToken: "FAKE-SECRET", proofDigest: "kept" } }, { durable: true });',
    '  return readFileSync(path, "utf8") === JSON.stringify(entry) + "\\n" && entry.metadata.secretToken === "[REDACTED]" && entry.metadata.proofDigest === "kept";',
    "});",
    'await record("audit appends durably outside the package and redacts secrets", () => {',
    '  const path = join(state, "audit.jsonl");',
    '  audit.appendAuditEntry(path, { type: "phase61.check", actor: "system", action: "acceptance", status: "success", metadata: { proofDigest: "x", secretToken: "y" } }, { durable: true });',
    '  audit.appendAuditEntry(path, { type: "phase61.check", actor: "system", action: "acceptance", status: "success" });',
    "  const entries = audit.readAuditEntries(path);",
    "  const first = entries[0];",
    "  return (",
    "    entries.length === 2 &&",
    "    first !== undefined &&",
    "    first.metadata !== undefined &&",
    '    first.metadata.secretToken === "[REDACTED]" &&',
    '    first.metadata.proofDigest === "x" &&',
    "    !path.startsWith(pkgDir)",
    "  );",
    "});",
    'await record("review checkpoint round-trips in an external path", async () => {',
    '  const store = checkpoint.createFileReviewCheckpointStore(join(state, "checkpoint.json"));',
    '  await store.save(checkpoint.createEmptyReviewCheckpoint("com.example.phase61"));',
    "  const loaded = await store.load();",
    '  return loaded !== undefined && loaded.packageName === "com.example.phase61" && Object.keys(loaded.reviews).length === 0;',
    "});",
    'await record("release edit session round-trips in an external path", async () => {',
    '  const store = sessions.createFileReleaseEditSessionStore(join(state, "edit-session.json"), { expectedPackageName: "com.example.phase61" });',
    "  const session = releases.createReleaseEditSession(",
    '    { packageName: "com.example.phase61", editId: "edit-phase61", expiryTimeSeconds: "1900000000" },',
    "    new Date().toISOString(),",
    "  );",
    "  await store.save(session);",
    '  const classified = await sessions.loadReleaseEditSessionState(store, "1800000000");',
    "  await store.clear();",
    '  return classified.status === "active" && classified.session.editId === "edit-phase61" && (await store.load()) === undefined;',
    "});",
    'await record("cleanup journal records and removes exact edit identities", async () => {',
    '  const store = journal.createFileReleaseEditCleanupJournal(join(state, "edit-cleanup-journal.json"), { expectedPackageName: "com.example.phase61" });',
    '  await store.record({ editId: "edit-phase61", expiryTimeSeconds: "1900000000", source: "exact_release_verification", createdAt: new Date().toISOString() });',
    "  const listed = await store.list();",
    '  await store.remove("edit-phase61");',
    '  return listed.length === 1 && listed[0].editId === "edit-phase61" && (await store.list()).length === 0;',
    "});",
    'await record("health report publishes exclusively with exact bytes and private mode", async () => {',
    '  const dir = join(state, "reports");',
    "  mkdirSync(dir, { recursive: true });",
    "  const created = report.createHealthReport(",
    '    { summary: "current 1 -> 2", comparison: { kinds: ["crash_rate"] } },',
    '    () => new Date("2026-10-03T00:30:45.123Z"),',
    "  );",
    "  const published = await report.writeHealthReport(dir, created);",
    "  const mode = statSync(published).mode & 0o777;",
    "  let collided = false;",
    "  try {",
    "    await report.writeHealthReport(dir, created);",
    "  } catch (error) {",
    '    collided = error instanceof report.HealthReportError && error.code === "REPORT_EXISTS";',
    "  }",
    '  return readFileSync(published, "utf8") === created.text && collided && (mode & 0o077) === 0;',
    "});",
    'await record("installed runtime still requires interactive approval for publish tools", async () => {',
    "  let executed = 0;",
    "  const tool = {",
    '    name: "fake.publish",',
    '    description: "Fake publish capability.",',
    '    permission: "publish",',
    "    inputSchema: { parse: (value) => value },",
    "    outputSchema: { parse: (value) => value },",
    "    async execute() {",
    "      executed += 1;",
    "      return { ok: true };",
    "    },",
    "    async verify() {",
    "      return true;",
    "    },",
    "  };",
    "  const registry = new tools.ToolRegistry();",
    "  registry.register(tool);",
    "  const decision = permissions.evaluateToolPermission(tool);",
    "  let turn = 0;",
    "  const llm = {",
    '    provider: "scripted",',
    "    async complete() {",
    "      turn += 1;",
    '      return turn === 1 ? { toolCalls: [{ id: "c1", name: "fake.publish", arguments: {} }], usage: { totalTokens: 1 } } : { content: "done", toolCalls: [], usage: { totalTokens: 1 } };',
    "    },",
    "  };",
    "  const binding = {",
    '    toolName: "fake.publish",',
    '    llm: { name: "fake.publish", description: "Fake publish capability.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },',
    '    approval: { createRequestDigest: () => "digest", createSafeSummary: () => "summary" },',
    '    serializeResult: () => "serialized",',
    "  };",
    "  const refused = await agent.runAgent({",
    "    llm,",
    "    registry,",
    "    bindings: [binding],",
    '    messages: [{ role: "user", content: "publish" }],',
    "    limits: { maxSteps: 2, maxToolCalls: 1, maxTotalTokens: 10 },",
    '    ledger: agent.createFileAgentLedger(join(state, "agent-audit.jsonl")),',
    '    runId: () => "phase61",',
    "  });",
    "  const cli = readFileSync(join(pkgDir, 'dist', 'cli', 'index.js'), 'utf8');",
    "  return (",
    "    decision.requiresApproval === true &&",
    '    decision.code === "APPROVAL_REQUIRED" &&',
    "    refused.ok === false &&",
    '    refused.code === "APPROVAL_REQUIRED" &&',
    "    executed === 0 &&",
    '    cli.includes("process.stdin.isTTY") &&',
    '    cli.includes("isInteractive ? { approvalPrompt")',
    "  );",
    "});",
    ...localFinalizationChecksSource(),
    ...daemonClientModuleChecksSource(),
    ...stage4c1InstalledChecksSource(),
    ...stage4c1aInstalledChecksSource(),
    'await record("installed checks wrote nothing inside the package directory", () =>',
    "  JSON.stringify(before) === JSON.stringify(listing(pkgDir)),",
    ");",
    "",
    'console.log("\\n" + JSON.stringify({ results, detail }));',
    "if (Object.values(results).some((value) => value !== true)) process.exitCode = 1;",
    "",
  ];
  return [...header, ...body].join("\n");
}

/** Stage 3F.5 import/smoke coverage, always inside the offline installed consumer. */
function v03InstalledImportChecksSource() {
  return [
    `
await record("v0.3 daemon operation and socket modules import from the installed tarball", async () => {
  const operations = await import("playops/dist/daemon/operations.js");
  const server = await import("playops/dist/daemon/server.js");
  const attach = await import("playops/dist/daemon/attach-notes.js");
  const commit = await import("playops/dist/daemon/commit-operations.js");
  const verify = await import("playops/dist/daemon/verify-committed-operations.js");
  const reconcile = await import("playops/dist/daemon/reconcile-commit-operations.js");
  return [operations.createDaemonOperations, server.createDaemonServer, attach.attachNotes,
    commit.prepareCommit, commit.executeCommit, verify.prepareVerifyCommitted,
    verify.executeVerifyCommitted, reconcile.prepareReconcileCommit,
    reconcile.executeReconcileCommit].every((entry) => typeof entry === "function");
});
await record("v0.3 approval, signature and durable authority modules import from the installed tarball", async () => {
  const resolver = await import("playops/dist/daemon/approval-resolver.js");
  const signature = await import("playops/dist/runtime/approvals/operator-signature.js");
  const pending = await import("playops/dist/daemon/pending-store.js");
  const view = await import("playops/dist/daemon/pending-view.js");
  const claims = await import("playops/dist/daemon/request-claim.js");
  const writeIntent = await import("playops/dist/releases/release-write-intent-store.js");
  const execution = await import("playops/dist/runtime/agent/execute-one-tool.js");
  // Availability only: never load the real pinned key or construct a live gateway.
  return [resolver.createOperatorSignatureApprovalResolver, signature.createOperatorApprovalVerifier,
    signature.createProductionOperatorVerifier, pending.createFilePendingOperationStore,
    view.approvalPayloadFor, view.approvalChallengeFor, claims.acquireRequestClaim,
    claims.releaseRequestClaim, writeIntent.createFileReleaseWriteIntentStore,
    execution.executeOneTool].every((entry) => typeof entry === "function");
});
await record("installed v5 approval modules expose canonical statement preimages and reject v4", async () => {
  const {createHash} = await import("node:crypto");
  const canonical = await import("playops/dist/approvals/canonical-json.js");
  const statement = await import("playops/dist/approvals/statement.js");
  const challenge = await import("playops/dist/approvals/challenge.js");
  const protocol = await import("playops/dist/daemon/protocol.js");
  const view = await import("playops/dist/daemon/pending-view.js");
  const open = await import("playops/dist/releases/open-tool.js");
  const commit = await import("playops/dist/releases/commit-approval.js");
  const verify = await import("playops/dist/releases/readback-approval.js");
  const reconcile = await import("playops/dist/releases/reconcile-commit-tool.js");
  const packageName = "com.example.installedstatements";
  const track = {track:"internal",releases:[{name:"Installed Candidate",status:"completed",versionCodes:["42"],releaseNotes:[{language:"en-US",text:"Installed 東京\\nNote"}]}]};
  const intent = commit.createReleaseCommitIntent({packageName,editId:"installed-original",targetTrack:"internal",versionCode:"42",targetTrackState:track,validatedEdit:{valid:true,expiryTimeSeconds:"4102444800"}});
  const verification = verify.createReleaseStateVerificationIntent({packageName,targetTrack:"internal",versionCode:"42",expectedReleaseName:intent.releaseName,expectedStateDigest:intent.stateDigest});
  const candidate = {version:1,attemptId:"11111111-2222-4333-8444-555555555555",packageName,editId:"installed-original",expiryTimeSeconds:"4102444800",targetTrack:"internal",versionCode:"42",releaseName:intent.releaseName,releaseStatus:"completed",expectedStateDigest:intent.stateDigest,validationExpiryTimeSeconds:"4102444800",requestDigest:intent.requestDigest,attemptedAtUtc:"2026-10-10T00:00:00.000Z",updatedAtUtc:"2026-10-10T00:00:00.000Z",state:"TRANSPORT_ATTEMPTED"};
  const statements = [open.createReleaseEditOpenStatement(packageName),commit.createReleaseCommitStatement(intent),verify.createReleaseStateVerificationStatement(verification),reconcile.createReleaseCommitReconciliationStatement(packageName,candidate,"verify_expired")];
  for (const text of statements) {
    const parsed = statement.parseApprovalStatementCanonical(text);
    const digest = createHash("sha256").update(text,"utf8").digest("hex");
    if (statement.approvalStatementDigest(text) !== digest) return false;
    const approval = view.approvalChallengeFor({requestId:candidate.attemptId,nonce:"n".repeat(43),toolName:parsed.toolName,permission:parsed.permission,packageName,requestDigest:digest,expiresAtUtc:"2026-10-10T00:10:00.000Z"},text);
    challenge.assertApprovalChallenge(approval);
    const response = protocol.parseDaemonResponse(JSON.parse(protocol.serializeDaemonResponse({protocolVersion:5,correlationId:"installed_semantics",outcome:"approval_required",approval}).toString("utf8")));
    if (response.approval.approvalStatementCanonical !== text || challenge.decodeApprovalPayload(approval.canonicalPayload).nonce !== "n".repeat(43)) return false;
  }
  let refused = false;
  try { protocol.parseDaemonRequest({protocolVersion:4,correlationId:"old",request:{kind:"status"}}); } catch (error) {refused = error.code === "UNSUPPORTED_PROTOCOL_VERSION";}
  return refused && statements.length === 4 && canonical.stableStringify({b:2,a:1}) === '{"a":1,"b":2}';
});
await record("installed daemon protocol and served operation map retain the frozen contracts", async () => {
  const protocol = await import("playops/dist/daemon/protocol.js");
  const operations = await import("playops/dist/daemon/operations.js");
  const pending = await import("playops/dist/daemon/pending-store.js");
  const claims = await import("playops/dist/daemon/request-claim.js");
  const signature = await import("playops/dist/runtime/approvals/operator-signature.js");
  const writeIntent = await import("playops/dist/releases/release-write-intent-store.js");
  const reconcile = await import("playops/dist/daemon/reconcile-commit-operations.js");
  const request = protocol.parseDaemonRequest({ protocolVersion: 5, correlationId: "installed_package_smoke", request: { kind: "status" } });
  const expected = ["status", "prepare_open_edit", "execute_open_edit", "attach_notes",
    "prepare_commit", "execute_commit", "prepare_verify_committed", "execute_verify_committed",
    "prepare_reconcile_commit", "execute_reconcile_commit"];
  return protocol.PLAYOPS_DAEMON_PROTOCOL_VERSION === 5 && request.request.kind === "status" &&
    JSON.stringify(operations.DAEMON_SERVED_OPERATIONS) === JSON.stringify(expected) &&
    pending.PENDING_RECORD_SCHEMA_VERSION === 2 && claims.REQUEST_CLAIM_SCHEMA_VERSION === 1 &&
    signature.OPERATOR_APPROVAL_PROTOCOL_VERSION === 1 && writeIntent.RELEASE_WRITE_INTENT_SCHEMA_VERSION === 1 &&
    reconcile.DAEMON_RECONCILIATION_MODE === "verify_expired";
});
`,
  ];
}

/** Stage 3F.1 exercises real installed modules behind the existing network blocker. */
function localFinalizationChecksSource() {
  return `
let localFinalizationFixture;
await record("complete Stage-3E proof finalizes locally in the installed package and releases the unresolved gate", async () => {
  const packageName = "com.example.installedfinalization";
  const at = "2026-10-09T00:00:00.000Z";
  const finalAt = "2026-10-09T00:00:10.000Z";
  const expectedStateDigest = "a".repeat(64);
  const path = join(state, "local-finalization", "private", "attempts.json");
  const auditPath = join(state, "local-finalization", "audit.jsonl");
  const attempts = commitAttempts.createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
  const input = { version: 1, packageName, editId: "original-installed-edit", expiryTimeSeconds: "4102444800", targetTrack: "internal", versionCode: "101", releaseName: "Installed Candidate", releaseStatus: "completed", expectedStateDigest, validationExpiryTimeSeconds: "4102444800", requestDigest: "c".repeat(64), attemptedAtUtc: at, updatedAtUtc: at };
  const prepared = await attempts.prepare(input);
  await attempts.transition(prepared.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
  await attempts.transition(prepared.attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", at, { acknowledgedAtUtc: at });
  const sink = commitEvidence.createCommitVerificationEvidenceJournalSink({ journal: attempts, attemptId: prepared.attemptId, packageName, expectedStateDigest, now: () => new Date(at) });
  for (const event of [
    { type: "verification_insert_attempted" },
    { type: "verification_edit_identified", editId: "PRIVATE-INSTALLED-VERIFICATION-EDIT", expiryTimeSeconds: "4102444900" },
    { type: "verification_state_observed", observedStateDigest: expectedStateDigest, observedAtUtc: at },
    { type: "verification_pre_delete_read_verified" },
    { type: "verification_delete_attempted" },
    { type: "verification_delete_acknowledged" },
    { type: "verification_cleanup_verified" },
  ]) await sink.record(event);
  const [candidate] = await attempts.list();
  const sessionStore = sessions.createFileReleaseEditSessionStore(join(state, "local-finalization", "session.json"), { expectedPackageName: packageName });
  const coordinator = packageOperations.createPackageOperationSingleFlightCoordinator();
  const options = { journal: attempts, sessionStore, candidate, auditLedger: { async append(entry) { audit.appendAuditEntry(auditPath, entry, { durable: true }); } }, now: () => new Date(finalAt) };
  const acquisition = coordinator.tryAcquirePackageOperation(packageName);
  if (!acquisition.acquired) throw new Error("Installed fixture package lease is busy");
  let result;
  try { result = await commitFinalization.finalizeVerifiedCommit(options); } finally { coordinator.releasePackageOperation(acquisition.lease); }
  const [terminal] = await attempts.list();
  localFinalizationFixture = { packageName, path, auditPath, attempts, candidate, sessionStore, coordinator, options };
  const retained = Object.entries(candidate).every(([key, value]) => key === "state" || key === "updatedAtUtc" || terminal[key] === value);
  const closed = result.outcome === "finalized" && terminal.state === "RECONCILED_COMMITTED" && terminal.verificationObservedStateDigest === expectedStateDigest && terminal.verificationCleanupVerified === true && !commitStatus.isCommitAttemptUnresolved(terminal);
  // Public journal behaviour, not a private predicate assertion: a new attempt
  // is now permitted, and later checks must still correlate the old exact ID.
  const next = await attempts.prepare({ ...input, editId: "later-installed-edit", versionCode: "102" });
  return closed && retained && next.state === "PREPARED" && next.attemptId !== candidate.attemptId;
});
await record("installed local finalization is idempotent without another journal or audit write", async () => {
  const f = localFinalizationFixture;
  if (!f) throw new Error("Installed finalization fixture did not complete");
  const bytes = readFileSync(f.path, "utf8");
  const auditBytes = readFileSync(f.auditPath, "utf8");
  const acquisition = f.coordinator.tryAcquirePackageOperation(f.packageName);
  if (!acquisition.acquired) throw new Error("Installed fixture package lease is busy");
  let result;
  try { result = await commitFinalization.finalizeVerifiedCommit(f.options); } finally { f.coordinator.releasePackageOperation(acquisition.lease); }
  return result.outcome === "already_finalized" && readFileSync(f.path, "utf8") === bytes && readFileSync(f.auditPath, "utf8") === auditBytes;
});
await record("installed finalization audit includes zero-Google proof without temporary identity", () => {
  const f = localFinalizationFixture;
  if (!f) throw new Error("Installed finalization fixture did not complete");
  const entries = audit.readAuditEntries(f.auditPath);
  const bytes = readFileSync(f.auditPath, "utf8");
  return entries.length === 1 && entries[0].metadata.attemptId === f.candidate.attemptId && entries[0].metadata.local_finalization === true && entries[0].metadata.googleCalls === 0 && !bytes.includes("PRIVATE-INSTALLED-VERIFICATION-EDIT") && !bytes.includes("4102444900");
});
await record("installed finalizer refuses a later managed session without clearing it", async () => {
  const f = localFinalizationFixture;
  if (!f) throw new Error("Installed finalization fixture did not complete");
  const session = { version: 1, packageName: f.packageName, editId: "later-installed-session", expiryTimeSeconds: "4102445000", createdAt: "2026-10-09T00:00:20.000Z" };
  await f.sessionStore.save(session);
  const bytes = readFileSync(f.path, "utf8");
  const acquisition = f.coordinator.tryAcquirePackageOperation(f.packageName);
  if (!acquisition.acquired) throw new Error("Installed fixture package lease is busy");
  let result;
  try { result = await commitFinalization.finalizeVerifiedCommit(f.options); } finally { f.coordinator.releasePackageOperation(acquisition.lease); }
  return result.outcome === "refused" && result.code === "MANAGED_EDIT_ALREADY_OPEN" && JSON.stringify(await f.sessionStore.load()) === JSON.stringify(session) && readFileSync(f.path, "utf8") === bytes;
});
`
    .trim()
    .split("\n");
}

/** Stage 4B.4 pure client modules, exercised inside the offline installed consumer. */
function daemonClientModuleChecksSource() {
  return `
await record("installed client pins the production socket endpoint to the daemon default", async () => {
  const transport = await import("playops/dist/client/transport.js");
  const config = await import("playops/dist/config/types.js");
  return transport.PRODUCTION_OPERATOR_SOCKET_PATH === config.DEFAULT_CONFIG.daemon.socketPath &&
    transport.PRODUCTION_OPERATOR_SOCKET_PATH === "/run/playops/playops.sock";
});
await record("installed client validates challenges, rejects tampering and preserves export bytes", async () => {
  const approval = await import("playops/dist/client/approval.js");
  const open = await import("playops/dist/releases/open-tool.js");
  const view = await import("playops/dist/daemon/pending-view.js");
  const statement = await import("playops/dist/approvals/statement.js");
  const statementText = open.createReleaseEditOpenStatement("com.example.clientacc");
  const challenge = view.approvalChallengeFor({ requestId: "11111111-2222-4333-8444-555555555555", nonce: "n".repeat(43), toolName: "releases.open_edit", permission: "destructive", packageName: "com.example.clientacc", requestDigest: statement.approvalStatementDigest(statementText), expiresAtUtc: "2026-10-10T00:10:00.000Z" }, statementText);
  approval.validateApprovalChallenge(challenge);
  const exported = approval.createApprovalExport(challenge, { requestId: challenge.requestId });
  const round = JSON.parse(approval.serializeApprovalExport(exported));
  let rejected = false;
  try { approval.validateApprovalChallenge({ ...challenge, requestDigest: "a".repeat(64) }); } catch { rejected = true; }
  return rejected && round.challenge.approvalStatementCanonical === statementText && round.challenge.canonicalPayload === challenge.canonicalPayload;
});
await record("installed client parses signature tokens strictly", async () => {
  const approval = await import("playops/dist/client/approval.js");
  const good = Buffer.alloc(64, 5).toString("base64url");
  let bad = 0;
  for (const token of [Buffer.alloc(63).toString("base64url"), Buffer.alloc(65).toString("base64url"), "abc=", ""]) {
    try { approval.parseSignatureToken(token); } catch { bad += 1; }
  }
  return approval.parseSignatureToken("  " + good + "\\n") === good && bad === 4;
});
await record("installed client renderer shows the four required sections", async () => {
  const render = await import("playops/dist/client/render.js");
  const open = await import("playops/dist/releases/open-tool.js");
  const view = await import("playops/dist/daemon/pending-view.js");
  const statement = await import("playops/dist/approvals/statement.js");
  const statementText = open.createReleaseEditOpenStatement("com.example.clientacc");
  const challenge = view.approvalChallengeFor({ requestId: "11111111-2222-4333-8444-555555555555", nonce: "n".repeat(43), toolName: "releases.open_edit", permission: "destructive", packageName: "com.example.clientacc", requestDigest: statement.approvalStatementDigest(statementText), expiresAtUtc: "2026-10-10T00:10:00.000Z" }, statementText);
  const text = render.renderApprovalStatement(challenge);
  return ["SEMANTIC AUTHORIZATION", "CONSEQUENCES", "INTEGRITY FINGERPRINTS", "REQUEST / EXPIRY"].every((heading) => text.includes(heading));
});
await record("installed client outcome set covers the protocol union with conservative exit codes", async () => {
  const outcome = await import("playops/dist/client/outcome.js");
  return outcome.DAEMON_RESPONSE_OUTCOMES.length === 17 &&
    outcome.exitCodeForOutcome("external_state_ambiguous") === 2 &&
    outcome.exitCodeForOutcome("cleanup_pending") === 2 &&
    outcome.exitCodeForOutcome("success") === 0 &&
    outcome.exitCodeForOutcome("remote_failure") === 1;
});
`
    .trim()
    .split("\n");
}

/**
 * Stage 4C.1 production transport/filesystem hardening, inside the consumer.
 * Exercises the installed socket allow-list, the fs-trust reader and the config
 * validator with real temp fixtures under the acceptance state directory.
 */
function stage4c1InstalledChecksSource() {
  return `
await record("installed production transport exposes the {0600,0660} socket-mode allow-list", async () => {
  const server = await import("playops/dist/daemon/server.js");
  const composition = await import("playops/dist/daemon/production-composition.js");
  return JSON.stringify(server.DAEMON_SOCKET_MODES) === JSON.stringify([0o600, 0o660]) &&
    server.DEFAULT_DAEMON_SOCKET_MODE === 0o600 &&
    server.isAllowedDaemonSocketMode(0o600) === true &&
    server.isAllowedDaemonSocketMode(0o660) === true &&
    server.isAllowedDaemonSocketMode(0o640) === false &&
    server.isAllowedDaemonSocketMode(0o666) === false &&
    composition.PRODUCTION_DAEMON_SOCKET_MODE === 0o660;
});
await record("installed fs-trust helper refuses a symlinked leaf and accepts a secure fixture", async () => {
  const trust = await import("playops/dist/shared/fs-trust.js");
  const uid = process.getuid();
  const dir = mkdtempSync(join(state, "trust-"));
  const target = join(dir, "anchor.pub");
  writeFileSync(target, "SECURE", { mode: 0o600 });
  chmodSync(target, 0o600);
  const accepted = trust.readTrustedRegularFile(target, { policy: { trustedOwnerUid: uid } });
  const link = join(dir, "link.pub");
  symlinkSync(target, link);
  let refused = false;
  try { trust.readTrustedRegularFile(link, { policy: { trustedOwnerUid: uid } }); }
  catch (error) { refused = error instanceof trust.FsTrustError && error.code === "TRUST_PATH_UNSAFE"; }
  return accepted === "SECURE" && refused && trust.TRUSTED_SYSTEM_UID === 0 && trust.DEFAULT_FS_TRUST_MAX_BYTES > 0;
});
await record("installed config validator refuses a symlinked config file and accepts a secure one", async () => {
  const composition = await import("playops/dist/daemon/production-composition.js");
  const types = await import("playops/dist/config/types.js");
  const uid = process.getuid();
  const root = mkdtempSync(join(state, "cfg-"));
  for (const name of ["pending", "claims", "write-intents", "state", "logs", "run"]) {
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
    chmodSync(join(root, name), 0o700);
  }
  const config = Object.assign({}, types.DEFAULT_CONFIG, {
    googlePlay: { packageName: "com.example.installed", serviceAccountJson: join(root, "sa.json") },
    audit: { logPath: join(root, "logs", "a.jsonl") },
    release: { editSessionPath: join(root, "state", "s.json"), editCleanupJournalPath: join(root, "state", "c.json"), commitAttemptJournalPath: join(root, "state", "k.json") },
    daemon: { socketPath: join(root, "run", "p.sock"), pendingStorePath: join(root, "pending"), claimRoot: join(root, "claims"), writeIntentStorePath: join(root, "write-intents") },
  });
  const real = join(root, "real.yaml");
  const nl = String.fromCharCode(10);
  writeFileSync(real, 'google_play:' + nl + '  package_name: "com.example.installed"' + nl, { mode: 0o640 });
  chmodSync(real, 0o640);
  const link = join(root, "playops.yaml");
  symlinkSync(real, link);
  const gid = lstatSync(root).gid;
  const policy = { trustedOwnerUid: uid, processGroupIdentity: { effectiveGid: gid + 1, supplementaryGids: [gid] } };
  let refused = false;
  try { composition.validateProductionDaemonConfig(config, link, policy); }
  catch (error) { refused = error instanceof composition.ProductionDaemonConfigError && error.code === "DAEMON_CONFIG_FILE_UNSAFE"; }
  const accepted = composition.validateProductionDaemonConfig(config, real, policy);
  return refused && accepted.configPath === real && accepted.packageName === "com.example.installed";
});
`
    .trim()
    .split("\n");
}

/**
 * Stage 4C.1A secret-file confidentiality, inside the installed consumer.
 * Verifies the installed code refuses a world-readable production config and a
 * world-readable production credential, still accepts a root-owned 0644 anchor,
 * and exposes the two named policies. Synthetic temp fixtures only; no real
 * secret, no host path created, no network.
 */
function stage4c1aInstalledChecksSource() {
  return `
await record("installed code refuses a world-readable production config and credential", async () => {
  const composition = await import("playops/dist/daemon/production-composition.js");
  const types = await import("playops/dist/config/types.js");
  const uid = process.getuid();
  const nl = String.fromCharCode(10);
  const root = mkdtempSync(join(state, "config4c1a-"));
  for (const name of ["pending", "claims", "write-intents", "state", "logs", "run"]) {
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
    chmodSync(join(root, name), 0o700);
  }
  mkdirSync(join(root, "etc"), { mode: 0o750 });
  chmodSync(join(root, "etc"), 0o750);
  mkdirSync(join(root, "creds"), { mode: 0o750 });
  chmodSync(join(root, "creds"), 0o750);
  const configPath = join(root, "etc", "playops.yaml");
  const credentialPath = join(root, "creds", "google-play.json");
  const config = Object.assign({}, types.DEFAULT_CONFIG, {
    googlePlay: { packageName: "com.example.installed", serviceAccountJson: credentialPath },
    audit: { logPath: join(root, "logs", "a.jsonl") },
    release: { editSessionPath: join(root, "state", "s.json"), editCleanupJournalPath: join(root, "state", "c.json"), commitAttemptJournalPath: join(root, "state", "k.json") },
    daemon: { socketPath: join(root, "run", "p.sock"), pendingStorePath: join(root, "pending"), claimRoot: join(root, "claims"), writeIntentStorePath: join(root, "write-intents") },
  });
  const gid = lstatSync(root).gid;
  const policy = { trustedOwnerUid: uid, processGroupIdentity: { effectiveGid: gid + 1, supplementaryGids: [gid] } };
  writeFileSync(configPath, 'google_play:' + nl + '  package_name: "com.example.installed"' + nl, { mode: 0o644 });
  chmodSync(configPath, 0o644);
  let worldReadableConfigRefused = false;
  try { composition.validateProductionDaemonConfig(config, configPath, policy); }
  catch (error) { worldReadableConfigRefused = error instanceof composition.ProductionDaemonConfigError && error.code === "DAEMON_CONFIG_FILE_UNSAFE"; }
  chmodSync(configPath, 0o640);
  const secureConfigAccepted = composition.validateProductionDaemonConfig(config, configPath, policy).configPath === configPath;
  const validated = composition.validateProductionDaemonConfig(config, configPath, policy);
  writeFileSync(credentialPath, "{}", { mode: 0o644 });
  chmodSync(credentialPath, 0o644);
  let worldReadableCredentialRefused = false;
  try { await composition.validateProductionDaemonFilesystem(validated, policy); }
  catch (error) { worldReadableCredentialRefused = error instanceof composition.ProductionDaemonConfigError && error.code === "DAEMON_CREDENTIAL_PATH_UNSAFE"; }
  chmodSync(credentialPath, 0o640);
  let secureCredentialAccepted = true;
  try { await composition.validateProductionDaemonFilesystem(validated, policy); }
  catch { secureCredentialAccepted = false; }
  return worldReadableConfigRefused && secureConfigAccepted && worldReadableCredentialRefused && secureCredentialAccepted;
});
await record("installed code still accepts a root-owned 0644 public anchor and exposes the two policies", async () => {
  const trust = await import("playops/dist/shared/fs-trust.js");
  const signature = await import("playops/dist/runtime/approvals/operator-signature.js");
  const crypto = await import("node:crypto");
  const pair = crypto.generateKeyPairSync("ed25519");
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const ANCHOR = "/etc/playops/operator-approval.pub";
  const PARENT = "/etc/playops";
  const nodes = new Map([
    [ANCHOR, { uid: 0, gid: 0, mode: 0o100644, size: Buffer.byteLength(pem), isFile: true, isDirectory: false, isSymbolicLink: false, content: pem }],
    [PARENT, { uid: 0, gid: 0, mode: 0o40750, size: 0, isFile: false, isDirectory: true, isSymbolicLink: false, content: "" }],
  ]);
  const open = new Map();
  let nextFd = 7;
  const openNode = (path) => { const node = nodes.get(path); if (!node) throw new Error("fake: missing"); const fd = nextFd; nextFd += 1; open.set(fd, node); return fd; };
  const port = {
    lstat: (path) => nodes.get(path),
    openReadNoFollow: (path) => openNode(path),
    openDirectoryNoFollow: (path) => openNode(path),
    fstat: (fd) => open.get(fd),
    readAll: (fd, limit) => Buffer.from(open.get(fd).content, "utf8").subarray(0, limit + 1),
    close: (fd) => { open.delete(fd); },
  };
  const key = signature.readPinnedProductionAnchor({ port });
  return key.asymmetricKeyType === "ed25519" &&
    signature.createProductionOperatorVerifier.length === 0 &&
    trust.publicIntegrityFilePolicy().trustedOwnerUid === 0 &&
    trust.publicIntegrityFilePolicy().secretConfidentiality === undefined &&
    trust.secretServiceFilePolicy().secretConfidentiality === true &&
    Array.isArray(trust.SECRET_SERVICE_ALLOWED_MODES) && trust.SECRET_SERVICE_ALLOWED_MODES.length === 2;
});
await record("installed secret-service policy refuses a 0644 leaf and accepts an exact 0640", async () => {
  const trust = await import("playops/dist/shared/fs-trust.js");
  const dir = mkdtempSync(join(state, "secret4c1a-"));
  const leaf = join(dir, "leaf");
  writeFileSync(leaf, "SECRET", { mode: 0o640 });
  chmodSync(leaf, 0o640);
  const gid = lstatSync(dir).gid;
  const policy = trust.secretServiceFilePolicy({ trustedOwnerUid: process.getuid(), processGroupIdentity: { effectiveGid: gid + 1, supplementaryGids: [gid] } });
  const accepted = trust.readTrustedRegularFile(leaf, { policy }) === "SECRET";
  chmodSync(leaf, 0o644);
  let refused = false;
  try { trust.readTrustedRegularFile(leaf, { policy }); }
  catch (error) { refused = error instanceof trust.FsTrustError && error.code === "TRUST_CONFIDENTIALITY_UNSAFE"; }
  return accepted && refused;
});
`
    .trim()
    .split("\n");
}

/**
 * Stage 4B.4 operator client over a real LOCAL AF_UNIX socket, with external
 * networking blocked and a narrowly scoped, isolated socket-root exception.
 */
function daemonClientSocketChecksSource() {
  return `
import { createServer } from "node:net";
import { mkdtempSync, rmSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const results = {};
const detail = {};
const record = async (name, fn) => {
  try {
    results[name] = (await fn()) === true;
    if (results[name] !== true) detail[name] = "returned a non-true value";
  } catch (error) {
    results[name] = false;
    detail[name] = String(error && error.message);
  }
};

await record("local socket consumer has the external network blocker active", async () => globalThis[Symbol.for("playops.acceptance.local-only")] === true);

const daemon = await import("playops/dist/cli/daemon.js");
const open = await import("playops/dist/releases/open-tool.js");
const view = await import("playops/dist/daemon/pending-view.js");
const statement = await import("playops/dist/approvals/statement.js");

const PACKAGE = "com.example.clientacc";
const UUID = "11111111-2222-4333-8444-555555555555";
const SIG = Buffer.alloc(64, 3).toString("base64url");
const statementText = open.createReleaseEditOpenStatement(PACKAGE);
const challenge = view.approvalChallengeFor({ requestId: UUID, nonce: "n".repeat(43), toolName: "releases.open_edit", permission: "destructive", packageName: PACKAGE, requestDigest: statement.approvalStatementDigest(statementText), expiresAtUtc: "2026-10-10T00:10:00.000Z" }, statementText);
const reply = (outcome, extra) => JSON.stringify(Object.assign({ protocolVersion: 5, correlationId: "acc", outcome }, extra || {}));

const tempDirs = [];
function startStub(handler) {
  const dir = mkdtempSync(join(process.env.PHASE61_AF_UNIX_ROOT, "c-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "stub.sock");
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const length = raw.readUInt32BE(0);
      const envelope = JSON.parse(raw.subarray(4, 4 + length).toString("utf8"));
      const action = handler(envelope.request, socket);
      if (action === "destroy") { socket.destroy(); return; }
      if (action === "hold") return;
      socket.write(Buffer.from(action, "utf8"));
      socket.end();
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, close: () => new Promise((res) => server.close(() => res())) })));
}
function makeIo() {
  const out = [];
  const err = [];
  return { io: { write: (text) => out.push(text), writeError: (text) => err.push(text) }, out, err, text: () => out.join("\\n") };
}

await record("status against a stub daemon on a test socket", async () => {
  const stub = await startStub(() => reply("status", { summary: "pending=0 completed=0" }));
  const c = makeIo();
  const code = await daemon.runDaemonCli(["status"], c.io, { socketPath: stub.socketPath });
  await stub.close();
  return code === 0 && c.text().includes("DAEMON STATUS") && c.text().includes("cannot resolve a specific requestId");
});

await record("prepare exports the challenge at 0600 and reconstructs the digest", async () => {
  const stub = await startStub(() => reply("approval_required", { approval: challenge }));
  const dir = mkdtempSync(join(process.env.PHASE61_AF_UNIX_ROOT, "o-"));
  tempDirs.push(dir);
  const outPath = join(dir, "challenge.json");
  const c = makeIo();
  const code = await daemon.runDaemonCli(["open", "prepare", "--out", outPath], c.io, { socketPath: stub.socketPath });
  await stub.close();
  const exported = JSON.parse(readFileSync(outPath, "utf8"));
  return code === 0 && (lstatSync(outPath).mode & 0o777) === 0o600 && exported.challenge.approvalStatementCanonical === statementText && exported.challenge.requestDigest === statement.approvalStatementDigest(statementText);
});

await record("tampered challenge is rejected before display", async () => {
  const tampered = Object.assign({}, challenge, { approvalStatementCanonical: statementText.replace("none", "tracked") });
  const stub = await startStub(() => reply("approval_required", { approval: tampered }));
  const c = makeIo();
  const code = await daemon.runDaemonCli(["open", "prepare"], c.io, { socketPath: stub.socketPath });
  await stub.close();
  return code === 2 && c.err.length > 0 && !c.text().includes("SEMANTIC AUTHORIZATION");
});

function runInstalledCli(socketPath, args, signatureText, onChild) {
  const program = 'const { runDaemonCli } = await import("playops/dist/cli/daemon.js"); process.exitCode = await runDaemonCli(process.argv.slice(2), { write: t => process.stdout.write(t), writeError: t => process.stderr.write(t) }, { socketPath: process.argv[1] });';
  const child = spawn(process.execPath, ["--import", process.env.PHASE61_BLOCKER, "--input-type=module", "-e", program, socketPath, ...args], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  if (onChild) onChild(child);
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", t => { stdout += t; });
  child.stderr.on("data", t => { stderr += t; });
  child.stdin.on("error", () => {});
  child.stdin.end(signatureText);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10000);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, stdout, stderr }); });
  });
}

await record("actual stdin EOF transports one signature token to the installed client", async () => {
  let dispatches = 0, received = false;
  const stub = await startStub((request) => { dispatches++; received = request.signature === SIG; return reply("success", { summary: "done" }); });
  const result = await runInstalledCli(stub.socketPath, ["open", "execute", "--request-id", UUID, "--signature-stdin"], SIG + "\\n");
  await stub.close();
  return result.code === 0 && !result.timedOut && received && dispatches === 1 && result.stdout.includes("OUTCOME: success") && !result.stdout.includes(SIG) && !result.stderr.includes(SIG);
});

await record("actual SIGINT after dispatch reports unknown outcome and never resends", async () => {
  let child, held, dispatches = 0;
  const stub = await startStub((_request, socket) => { dispatches++; held = socket; child.kill("SIGINT"); return "hold"; });
  const result = await runInstalledCli(stub.socketPath, ["commit", "execute", "--request-id", UUID, "--signature-stdin"], SIG, c => { child = c; });
  if (held) held.destroy();
  await stub.close();
  return result.code === 2 && !result.timedOut && dispatches === 1 && result.stderr.includes("OUTCOME UNKNOWN FROM CLIENT PERSPECTIVE");
});

await record("prepare response loss reports unknown local pending state without replay", async () => {
  let dispatches = 0;
  const stub = await startStub(() => { dispatches++; return "destroy"; });
  const c = makeIo();
  const code = await daemon.runDaemonCli(["open", "prepare"], c.io, { socketPath: stub.socketPath });
  await stub.close();
  return code === 2 && dispatches === 1 && c.err.join(" ").includes("another prepare may create another pending request");
});

await record("connect failure exits 1 with zero mutation", async () => {
  const c = makeIo();
  const code = await daemon.runDaemonCli(["status"], c.io, { socketPath: join(process.env.PHASE61_AF_UNIX_ROOT, "absent-" + Date.now() + ".sock") });
  return code === 1 && c.err.length > 0;
});

await record("post-dispatch disconnect exits 2 without replay", async () => {
  const stub = await startStub(() => "destroy");
  const c = makeIo();
  const code = await daemon.runDaemonCli(["commit", "execute", "--request-id", UUID, "--signature-stdin"], c.io, { socketPath: stub.socketPath, readSignature: async () => SIG });
  await stub.close();
  return code === 2;
});

for (const dir of tempDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
console.log("\\n" + JSON.stringify({ results, detail }));
if (Object.values(results).some((value) => value !== true)) process.exitCode = 1;
`;
}

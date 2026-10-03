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
  RUNTIME_DEPENDENCIES,
} from "./package-content.mjs";

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
for (const dir of [source, artifacts, consumer, workdir, stateDir])
  mkdirSync(dir, { recursive: true });

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
    'net.Socket.prototype.connect = function () { return record("net.connect"); };',
    'dns.lookup = () => record("dns.lookup");',
    'dns.promises.lookup = () => record("dns.promises.lookup");',
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
    .filter((path) => /^(src|tests|scripts)\//u.test(path));
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
    "payload excludes repository source, tests, docs and dev scripts",
    !packlist.some((path) => /^(src|tests|scripts|docs)\//.test(path)),
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
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "phase61-consumer", version: "0.0.0", private: true }, null, 2),
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
    'import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";',
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
    "",
  ];
  const body = [
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

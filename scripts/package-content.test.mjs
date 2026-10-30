import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPackageContents,
  assertPackageMetadata,
  DEPLOYMENT_TEMPLATE_FILES,
  DEPLOYMENT_TEMPLATE_GLOBS,
  findPathViolations,
  FORBIDDEN_SCRIPTS,
  OPERATOR_DOC_FILES,
  REQUIRED_FILES,
  REQUIRED_PAYLOAD_FILES,
  ROOT_PAYLOAD_FILES,
  RUNTIME_DEPENDENCIES,
  REQUIRED_MODULE_FILES,
} from "./package-content.mjs";

const EXPECTED_PREPACK = "npm run build && node scripts/normalize-package-modes.mjs";

const metadata = () => ({
  name: "playops",
  version: "1.2.3",
  license: "MIT",
  private: true,
  type: "module",
  engines: { node: ">=24 <25" },
  bin: { playops: "dist/cli/index.js", playopsd: "dist/daemon/main.js" },
  files: [
    "dist/**/*.js",
    "config/playops.example.yaml",
    "config/playops.production.example.yaml",
    "CHANGELOG.md",
    ...OPERATOR_DOC_FILES,
    ...DEPLOYMENT_TEMPLATE_GLOBS,
  ],
  dependencies: { ...RUNTIME_DEPENDENCIES },
  scripts: { prepack: EXPECTED_PREPACK },
});
test("accepts CLI-only metadata and the minimum safe runtime payload", () => {
  assert.doesNotThrow(() => assertPackageMetadata(metadata()));
  assert.doesNotThrow(() => assertPackageContents([...REQUIRED_FILES], metadata()));
});
for (const path of [
  "config/playops.yaml",
  "config/service-account.json",
  "credentials/operator.json",
  ".env",
  ".env.local",
  "logs/playops.audit.jsonl",
  "reports/playops-health-report.txt",
  "data/reviews/checkpoint.json",
  "data/releases/edit-session.json",
  "data/releases/edit-cleanup-journal.json",
  "app.aab",
  "PLAYOPS_PLAN.md",
  "docs/architecture.md",
  "docs/decisions.md",
  "docs/phase-4.15-plan.md",
  "docs/phase-4.15-b4-probe-plan.md",
  "docs/unapproved.md",
  "docs/nested/credentials.md",
  "docs/credentials.md/secret.json",
  "tests/example.test.ts",
  "src/index.ts",
  ".git/HEAD",
  "node_modules/yaml/index.js",
  ".hermes/cache/scratch/file",
  "scratch/file",
  "dist/config/service-account.json",
  "dist/config/credentials.json",
  "dist/cli/index.js.map",
  "dist/cli/index.d.ts",
  "/etc/passwd",
  "../outside",
  "dist/../secret.js",
  "dist\\secret.js",
  "dist/secret\nfile.js",
]) {
  test(`rejects forbidden/private/development path ${JSON.stringify(path)}`, () => {
    assert.throws(() => assertPackageContents([...REQUIRED_FILES, path], metadata()));
  });
}
test("rejects duplicate/missing entries and a stale unexpected compiled module", () => {
  assert.throws(() => assertPackageContents([...REQUIRED_FILES, REQUIRED_FILES[0]], metadata()));
  assert.throws(() => assertPackageContents(REQUIRED_FILES.slice(1), metadata()));
  const modules = REQUIRED_FILES.filter((path) => path.startsWith("dist/"));
  assert.throws(() =>
    assertPackageContents([...REQUIRED_FILES, "dist/rogue.js"], metadata(), modules),
  );
});
for (const update of [
  { main: "dist/index.js" },
  { exports: {} },
  { types: "dist/index.d.ts" },
  { private: false },
  { name: "other" },
  { version: "1.2" },
  { version: "v1.2.3" },
  { version: 1.2 },
  { license: "other" },
  { type: "commonjs" },
  { engines: { node: ">=26" } },
  { bin: { playops: "src/cli/index.ts" } },
  { files: ["*"] },
  { dependencies: {} },
  { scripts: { prepack: EXPECTED_PREPACK, install: "npm run build" } },
  { scripts: { prepack: EXPECTED_PREPACK, prepare: "npm run build" } },
]) {
  test(`rejects drifted or install-compiling metadata ${JSON.stringify(update)}`, () =>
    assert.throws(() => assertPackageMetadata({ ...metadata(), ...update })));
}
for (const invalidScripts of [
  undefined,
  {},
  { prepack: "" },
  { prepack: "tsc" },
  { prepack: "npm run build" },
  { prepack: "node scripts/normalize-package-modes.mjs" },
  { prepack: "node scripts/normalize-package-modes.mjs && npm run build" },
  { prepack: "npm run build; node scripts/normalize-package-modes.mjs" },
  { prepack: "npm run build || node scripts/normalize-package-modes.mjs" },
  { prepack: "npm run build & node scripts/normalize-package-modes.mjs" },
  { prepack: "npm run build && node scripts/normalize-package-modes.mjs --force" },
  { prepack: ` ${EXPECTED_PREPACK} ` },
]) {
  test(`rejects non-exact prepack lifecycle ${JSON.stringify(invalidScripts)}`, () => {
    assert.throws(
      () => assertPackageMetadata({ ...metadata(), scripts: invalidScripts }),
      /scripts\.prepack must build the artifact and normalize package modes before packing/u,
    );
  });
}
for (const hook of FORBIDDEN_SCRIPTS) {
  test(`rejects forbidden lifecycle hook scripts.${hook} even when prepack is valid`, () => {
    assert.throws(
      () =>
        assertPackageMetadata({
          ...metadata(),
          scripts: { prepack: EXPECTED_PREPACK, [hook]: "npm run build" },
        }),
      new RegExp(
        `^Error: scripts\\.${hook} must stay absent: installs must not compile or fetch$`,
        "u",
      ),
    );
  });
}
for (const path of [
  "dist/approvals/canonical-json.js",
  "dist/approvals/statement.js",
  "dist/approvals/challenge.js",
]) {
  test(`Stage4B.1 requires the compiled human-verifiable approval module ${path}`, () => {
    assert.ok(REQUIRED_MODULE_FILES.includes(path), `${path} must be required`);
    assert.throws(() =>
      assertPackageContents(
        REQUIRED_FILES.filter((p) => p !== path),
        metadata(),
      ),
    );
  });
}

test("requires the release changelog in the payload", () => {
  const withoutChangelog = REQUIRED_FILES.filter((path) => path !== "CHANGELOG.md");
  assert.throws(() => assertPackageContents(withoutChangelog, metadata()), /CHANGELOG\.md/u);
});
test("every root release-consumer file is a required payload file", () => {
  for (const path of ROOT_PAYLOAD_FILES) {
    assert.ok(REQUIRED_FILES.includes(path), `${path} must be required`);
  }
  assert.ok(ROOT_PAYLOAD_FILES.includes("CHANGELOG.md"));
});

const completePayload = () => [
  ...new Set([
    ...ROOT_PAYLOAD_FILES,
    ...OPERATOR_DOC_FILES,
    ...DEPLOYMENT_TEMPLATE_FILES,
    ...REQUIRED_MODULE_FILES,
  ]),
];

test("requires both deployment templates and accepts a complete payload", () => {
  assert.deepEqual(DEPLOYMENT_TEMPLATE_FILES, [
    "deploy/systemd/playops.service",
    "deploy/tmpfiles.d/playops.conf",
  ]);
  for (const path of DEPLOYMENT_TEMPLATE_FILES) {
    assert.ok(REQUIRED_PAYLOAD_FILES.includes(path), `${path} must be required`);
    assert.ok(REQUIRED_FILES.includes(path), `${path} must be required`);
    assert.deepEqual(findPathViolations(path), []);
  }
  assert.doesNotThrow(() => assertPackageContents(completePayload(), metadata()));
});

for (const path of DEPLOYMENT_TEMPLATE_FILES) {
  test(`rejects payload omitting deployment template ${path}`, () => {
    const withoutTemplate = completePayload().filter((entry) => entry !== path);
    const escaped = JSON.stringify(path).replaceAll(".", "\\.");
    assert.throws(
      () => assertPackageContents(withoutTemplate, metadata()),
      new RegExp(`${escaped} is missing`, "u"),
    );
  });
}

for (const path of [
  "deploy/extra.conf",
  "deploy/README.md",
  "deploy/systemd/extra.service",
  "deploy/tmpfiles.d/extra.conf",
  "deploy/systemd/playops.service/extra.conf",
  "deploy/tmpfiles.d/playops.conf/extra.conf",
]) {
  test(`rejects unapproved deployment path ${JSON.stringify(path)}`, () => {
    assert.deepEqual(findPathViolations(path), ["is not an approved deployment template"]);
    const escaped = JSON.stringify(path).replaceAll(".", "\\.");
    assert.throws(
      () => assertPackageContents([...completePayload(), path], metadata()),
      new RegExp(`${escaped} is not an approved deployment template`, "u"),
    );
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPackageContents,
  assertPackageMetadata,
  OPERATOR_DOC_FILES,
  REQUIRED_FILES,
  ROOT_PAYLOAD_FILES,
  RUNTIME_DEPENDENCIES,
} from "./package-content.mjs";

const metadata = () => ({
  name: "playops",
  version: "1.2.3",
  license: "MIT",
  private: true,
  type: "module",
  engines: { node: ">=24 <25" },
  bin: { playops: "dist/cli/index.js" },
  files: ["dist/**/*.js", "config/playops.example.yaml", "CHANGELOG.md", ...OPERATOR_DOC_FILES],
  dependencies: { ...RUNTIME_DEPENDENCIES },
  scripts: { prepack: "npm run build" },
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
  { scripts: { prepack: "tsc", install: "npm run build" } },
  { scripts: { prepack: "npm run build", prepare: "npm run build" } },
]) {
  test(`rejects drifted or install-compiling metadata ${JSON.stringify(update)}`, () =>
    assert.throws(() => assertPackageMetadata({ ...metadata(), ...update })));
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

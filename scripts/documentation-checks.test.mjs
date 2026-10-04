import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertOperatorDocumentation,
  assertSafePublicText,
  codeBlocks,
  documentationLinks,
  shellCommands,
} from "./documentation-checks.mjs";
import { REQUIRED_PAYLOAD_FILES } from "./package-content.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("validates all five public documents and their installed-payload links", () => {
  const result = assertOperatorDocumentation(root);
  assert.equal(result.documents.length, 5);
  assert.ok(result.relativeLinks > 0);
  assert.ok(result.cliExamples.includes("playops --help"));
});
test("extracts multiline shell examples and ignores links inside fences", () => {
  const text =
    "[Guide](docs/credentials.md)\n```sh\nplayops health report \\\n --granularity DAILY\n```\n```text\n[Not a link](missing.md)\n```\n";
  assert.equal(codeBlocks(text).length, 2);
  assert.deepEqual(shellCommands(text), ["playops health report  --granularity DAILY"]);
  assert.deepEqual(documentationLinks(text), ["docs/credentials.md"]);
});
for (const unsafe of [
  "/home/example/private.json",
  "/Users/example/private.json",
  "example@project.iam.gserviceaccount.com",
  '"private_key": "not-even-a-real-key"',
  '"client_secret": "example"',
  "-----BEGIN PRIVATE KEY-----",
  "ya29.example",
  "```sh\nnpm install -g playops\n```\n",
  "```sh\nnpm install playops\n```\n",
  "```sh\nnpm publish\n```\n",
]) {
  test(`rejects unsafe public example ${JSON.stringify(unsafe)}`, () => {
    assert.throws(() => assertSafePublicText(unsafe));
  });
}
for (const href of ["missing.md", "docs/architecture.md", "docs/credentials.md#missing-heading"]) {
  test(`rejects broken or repository-only installed link ${href}`, () => {
    const fixture = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-doc-check-"));
    try {
      for (const file of REQUIRED_PAYLOAD_FILES) {
        mkdirSync(dirname(join(fixture, file)), { recursive: true });
        cpSync(join(root, file), join(fixture, file), { recursive: true });
      }
      const readme = join(fixture, "README.md");
      writeFileSync(readme, `${readFileSync(readme, "utf8")}\n[Test](${href})\n`);
      assert.throws(() => assertOperatorDocumentation(fixture));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

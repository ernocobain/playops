/** Lightweight checks for the public release documents, not a docs framework. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { OPERATOR_DOC_FILES, REQUIRED_PAYLOAD_FILES } from "./package-content.mjs";

export const PUBLIC_DOCUMENTS = Object.freeze(["README.md", "CHANGELOG.md", ...OPERATOR_DOC_FILES]);

export function codeBlocks(text) {
  return [...text.matchAll(/^```([a-z0-9_-]*)\r?\n([\s\S]*?)^```\s*$/gmu)].map((match) => ({
    language: match[1],
    text: match[2],
  }));
}

export function shellCommands(text) {
  return codeBlocks(text)
    .filter((block) => block.language === "sh" || block.language === "bash")
    .flatMap((block) =>
      block.text
        .replace(/\\\r?\n\s*/gu, " ")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
}

export function documentationLinks(text) {
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gmu, "");
  return [...prose.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/gu)].map((match) => match[1]);
}

export function headingAnchors(text) {
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) =>
      match[1]
        .toLowerCase()
        .replace(/[`*_]/gu, "")
        .replace(/[^a-z0-9 -]/gu, "")
        .replace(/ /gu, "-"),
    ),
  );
}

/** Documentation must stay safe even when copied into a consumer tarball. */
export function assertSafePublicText(text) {
  assert.doesNotMatch(
    text,
    /\/home\/|\/Users\/|\.hermes\/|\.omh\/|dhikrama|bizdirect|calm-drive|\.iam\.gserviceaccount\.com/iu,
    "public documentation contains an operator/host identity or private path",
  );
  assert.doesNotMatch(
    text,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:private_key|client_email|client_secret)"\s*:|\bya29\.[A-Za-z0-9_-]+/u,
    "public documentation contains credential material rather than a path/reference",
  );
  for (const command of shellCommands(text)) {
    assert.doesNotMatch(command, /^npm\s+install\s+(?:-g\s+)?playops(?:\s|$)/u);
    assert.doesNotMatch(command, /^npm\s+publish(?:\s|$)/u);
  }
}

/** This reads only public payload files. Works identically in repo and installed tree. */
export function assertOperatorDocumentation(root) {
  const allowed = new Set(REQUIRED_PAYLOAD_FILES.map((file) => resolve(root, file)));
  let relativeLinks = 0;
  const cliExamples = [];
  for (const file of PUBLIC_DOCUMENTS) {
    const source = resolve(root, file);
    assert.ok(existsSync(source), `promised operator document missing: ${file}`);
    const text = readFileSync(source, "utf8");
    assertSafePublicText(text);
    cliExamples.push(...shellCommands(text).filter((command) => command.startsWith("playops ")));
    for (const href of documentationLinks(text)) {
      if (/^https:\/\//u.test(href)) continue;
      const [path, anchor] = href.split("#");
      const target = path ? resolve(dirname(source), path) : source;
      assert.ok(allowed.has(target), `${file} links outside promised installed payload: ${href}`);
      assert.ok(existsSync(target), `${file} has a broken relative link: ${href}`);
      if (anchor) {
        assert.ok(
          headingAnchors(readFileSync(target, "utf8")).has(anchor),
          `${file} has a missing heading anchor: ${href}`,
        );
      }
      relativeLinks += 1;
    }
  }
  return { documents: [...PUBLIC_DOCUMENTS], relativeLinks, cliExamples };
}

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Source policy tests only; no network, checkpoint, Google, browser, or LLM. */
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const imports = (text: string): string[] => {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  return Array.from(
    withoutComments.matchAll(/from\s+["']([^"']+)["']/g),
    (match) => match[1] ?? "",
  );
};

describe("Phase 3.4 isolation and explicit publish boundary", () => {
  it("drafting has no import path to publication or Publisher; publishing has no LLM, classification, checkpoint or browser path", () => {
    const draft = imports(source("../src/reviews/drafting/tool.ts"));
    expect(draft.join(" ")).not.toMatch(/publishing|googleplay|checkpoint|approvals/);
    const domain = imports(source("../src/reviews/publishing/index.ts"));
    const tool = imports(source("../src/reviews/publishing/tool.ts"));
    const adapter = imports(source("../src/reviews/publishing/androidpublisher.ts"));
    expect([...domain, ...tool, ...adapter].join(" ")).not.toMatch(
      /classification|checkpoint|browser|runtime\/llm|9router|source\/androidpublisher/,
    );
    expect(adapter).toContain("../../googleplay/publisher/index.js");
    const active = [
      source("../src/reviews/publishing/index.ts"),
      source("../src/reviews/publishing/tool.ts"),
    ].join("\n");
    expect(active).not.toMatch(/\.complete\(|fetch\(|listReviews\(|saveCheckpoint\(/);
  });
  it("the only Publisher mutation call site is the narrowly scoped one-attempt wrapper", () => {
    const publisher = source("../src/googleplay/publisher/index.ts");
    expect(publisher.match(/client\.reviews\.reply\(/g)).toHaveLength(1);
    expect(publisher).toContain("{ retry: false }");
  });
});

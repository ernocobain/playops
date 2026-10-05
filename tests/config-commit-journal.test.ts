import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, envOverrides, parseConfigYaml } from "../src/config/index.js";
import { createReleaseComposition } from "../src/releases/composition.js";
import { createReleaseCommitIntent } from "../src/releases/commit-approval.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";

describe("R6 opt-in commit journal configuration", () => {
  it("keeps a legacy release config loadable without inventing a recovery location", () => {
    const legacy = parseConfigYaml(
      "release:\n  edit_session_path: ./private/edit.json\n  edit_cleanup_journal_path: ./private/cleanup.json\n",
    );
    expect(legacy.release).toEqual({
      editSessionPath: "./private/edit.json",
      editCleanupJournalPath: "./private/cleanup.json",
    });
    expect(DEFAULT_CONFIG.release).not.toHaveProperty("commitAttemptJournalPath");
  });
  it("loads only an explicitly supplied commit journal path", () => {
    expect(
      parseConfigYaml("release:\n  commit_attempt_journal_path: ./private/commit-attempts.json\n")
        .release,
    ).toEqual({ commitAttemptJournalPath: "./private/commit-attempts.json" });
  });
  it("uses the explicit journal-path environment override consistently with release stores", () => {
    expect(
      envOverrides({ PLAYOPS_RELEASE_COMMIT_ATTEMPT_JOURNAL_PATH: "./operator/attempts.json" })
        .release,
    ).toEqual({ commitAttemptJournalPath: "./operator/attempts.json" });
  });
  it("fails commit composition closed for an old config with no explicit durable path", () => {
    const config = {
      ...DEFAULT_CONFIG,
      googlePlay: {
        packageName: "com.example.oldconfig",
        serviceAccountJson: "FAKE-CREDENTIAL-PATH",
      },
      release: {
        editSessionPath: "private/edit.json",
        editCleanupJournalPath: "private/cleanup.json",
      },
      audit: { logPath: "private/audit.jsonl" },
    };
    const publisher = {
      version: "v3",
      reviews: {},
      edits: {},
    } as unknown as AndroidPublisherClient;
    const intent = createReleaseCommitIntent({
      packageName: config.googlePlay.packageName,
      editId: "old-edit",
      targetTrack: "internal",
      versionCode: "3",
      targetTrackState: {
        track: "internal",
        releases: [{ name: "3 (1.1)", status: "completed", versionCodes: ["3"] }],
      },
      validatedEdit: { valid: true, expiryTimeSeconds: "1900000000" },
    });
    let failure: unknown;
    try {
      createReleaseComposition(config, { publisher }, { commitEdit: { intent } });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toMatchObject({ name: "ReleaseCompositionError", code: "CONFIG_INVALID" });
    expect((failure as Error).message).toContain("commit-attempt journal");
    const allowed = createReleaseComposition(config, { publisher });
    expect(allowed.registry.has("releases.open_edit")).toBe(true);
    expect(allowed.registry.has("releases.validate_edit")).toBe(true);
  });

  it("refuses a non-string commit journal path", () => {
    expect(() => parseConfigYaml("release:\n  commit_attempt_journal_path: false\n")).toThrow();
  });
});

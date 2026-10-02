import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  type PlayOpsConfig,
  type ServiceAccountCredentials,
} from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { ANDROID_PUBLISHER_SCOPE, type GoogleAuthClient } from "../src/googleplay/auth/index.js";
import { RELEASES_VALIDATE_EDIT_TOOL_NAME } from "../src/releases/validate-edit-tool.js";
import { RELEASES_COMMIT_EDIT_TOOL_NAME } from "../src/releases/commit-approval.js";
import { createLiveReleaseComposition } from "../src/releases/composition.js";
import { RELEASES_OPEN_EDIT_TOOL_NAME } from "../src/releases/open-tool.js";
import { RELEASES_INSPECT_TOOL_NAME } from "../src/releases/tool.js";

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  tempDir = undefined;
  vi.restoreAllMocks();
});

function configWithAuditPath(logPath: string): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: {
      packageName: "com.example.release",
      serviceAccountJson: "FAKE-CREDENTIAL-PATH",
    },
    audit: { logPath },
    release: {
      editSessionPath: join(dirname(logPath), "edit-session.json"),
      editCleanupJournalPath: join(dirname(logPath), "edit-cleanup-journal.json"),
    },
  };
}

const credentials: ServiceAccountCredentials = {
  type: "service_account",
  clientEmail: "fake@example.invalid",
  privateKey: "FAKE-PRIVATE-KEY",
  tokenUri: "https://oauth.example.invalid/token",
  sourcePath: "/fake/credentials.json",
};
const auth: GoogleAuthClient = {
  getAccessToken: async () => ({ token: "FAKE-ACCESS-TOKEN" }),
};
const publisher = { version: "v3", reviews: {}, edits: {} } as unknown as AndroidPublisherClient;

describe("release composition root", () => {
  it("loads credentials, auth, and the existing Publisher client exactly once", async () => {
    tempDir = mkdtempSync(
      join(process.env.TMPDIR ?? process.cwd(), "playops-release-composition-"),
    );
    const config = configWithAuditPath(join(tempDir, "audit.jsonl"));
    const loadConfig = vi.fn(() => config);
    const loadCredentials = vi.fn((_config: PlayOpsConfig) => credentials);
    const authenticate = vi.fn(
      (_credentials: ServiceAccountCredentials, scopes: readonly string[]) => {
        expect(scopes).toEqual([ANDROID_PUBLISHER_SCOPE]);
        return auth;
      },
    );
    const createPublisher = vi.fn((_auth: GoogleAuthClient) => publisher);

    const composition = await createLiveReleaseComposition({
      loadConfig,
      loadCredentials,
      authenticate,
      createPublisher,
    });

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(loadCredentials).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(createPublisher).toHaveBeenCalledTimes(1);
    expect(createPublisher).toHaveBeenCalledWith(auth);
    expect(composition.packageName).toBe("com.example.release");
    expect(composition.registry.get(RELEASES_INSPECT_TOOL_NAME).permission).toBe("read");
    expect(composition.inspectBinding.toolName).toBe(RELEASES_INSPECT_TOOL_NAME);
    expect(composition.openBinding.toolName).toBe(RELEASES_OPEN_EDIT_TOOL_NAME);
    expect(composition.registry.get(RELEASES_OPEN_EDIT_TOOL_NAME).permission).toBe("destructive");
    expect(composition.registry.get(RELEASES_INSPECT_TOOL_NAME).verify).toBeUndefined();
    expect(composition.registry.get(RELEASES_OPEN_EDIT_TOOL_NAME).verify).toBeTypeOf("function");
    expect(composition.registry.get(RELEASES_VALIDATE_EDIT_TOOL_NAME).permission).toBe("read");
    expect(composition.registry.get(RELEASES_VALIDATE_EDIT_TOOL_NAME).verify).toBeUndefined();
    expect(composition.validateEditBinding.toolName).toBe(RELEASES_VALIDATE_EDIT_TOOL_NAME);
    expect(composition.registry.has(RELEASES_COMMIT_EDIT_TOOL_NAME)).toBe(false);
    // Phase 4.15: a configured cleanup-journal path adds the read-only hygiene tool.
    expect(composition.registry.has("releases.inspect_edit_hygiene")).toBe(true);
    expect(composition.registry.get("releases.inspect_edit_hygiene").permission).toBe("read");
    expect(composition.registry.list()).toHaveLength(4);
  });

  it("fails invalid package config before credentials, auth, or client construction", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      googlePlay: { packageName: "", serviceAccountJson: "FAKE-CREDENTIAL-PATH" },
      audit: { logPath: "fake-audit.jsonl" },
    } satisfies PlayOpsConfig;
    const loadCredentials = vi.fn(() => credentials);
    const authenticate = vi.fn(() => auth);
    const createPublisher = vi.fn(() => publisher);

    await expect(
      createLiveReleaseComposition({
        loadConfig: () => config,
        loadCredentials,
        authenticate,
        createPublisher,
      }),
    ).rejects.toMatchObject({ name: "ReleaseCompositionError", code: "CONFIG_INVALID" });
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(createPublisher).not.toHaveBeenCalled();
  });
});

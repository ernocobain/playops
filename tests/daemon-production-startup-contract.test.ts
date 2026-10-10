/**
 * Stage 4C.4 — production startup contract.
 *
 * Proves the production configuration example plus the declared directory
 * layout is sufficient to construct the production daemon composition. It is a
 * CONSTRUCTION-ONLY proof: no socket is bound, no network call is made, no
 * Google client is reached and no credential content is read. Temporary
 * fixtures only; /etc/playops is never created.
 */
import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as NodeDns from "node:dns";
import type * as NodeHttp from "node:http";
import type * as NodeHttps from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceAccountCredentials } from "../src/config/index.js";
import type { GoogleAuthClient } from "../src/googleplay/auth/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { createProductionDaemonApplication } from "../src/daemon/production-composition.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";

/** Any http/https request or DNS lookup during startup throws immediately. */
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeHttp>();
  return {
    ...actual,
    request: () => {
      throw new Error("http.request must not be called during daemon startup");
    },
  };
});
vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeHttps>();
  return {
    ...actual,
    request: () => {
      throw new Error("https.request must not be called during daemon startup");
    },
  };
});
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeDns>();
  return {
    ...actual,
    lookup: () => {
      throw new Error("dns.lookup must not be called during daemon startup");
    },
  };
});

const EXAMPLE_PATH = fileURLToPath(
  new URL("../config/playops.production.example.yaml", import.meta.url),
);
const VALID_PACKAGE = "com.example.playops";

const PROBE = mkdtempSync(join(tmpdir(), "playops-4c4-startup-probe-"));
const TEST_GID = lstatSync(PROBE).gid;
rmSync(PROBE, { recursive: true, force: true });
const TEST_POLICY = {
  trustedOwnerUid: process.getuid?.() ?? 0,
  processGroupIdentity: { effectiveGid: TEST_GID + 1, supplementaryGids: [TEST_GID] },
};

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-4c4-startup-"));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The production example, remapped under a temp root exactly as the brief's
 * directory layout: substitute the placeholder package name and prefix every
 * declared absolute path with the temporary root.
 */
function remappedExample(root: string): string {
  const text = readFileSync(EXAMPLE_PATH, "utf8").replace('"<package-name>"', `"${VALID_PACKAGE}"`);
  return text.replace(/"(\/[^"\n]*)"/gu, (_match, path: string) => `"${join(root, path)}"`);
}

/** Provision the layout the example declares plus the tmpfiles directories. */
function provision(root: string): string {
  for (const dir of [
    "var/lib/playops/pending",
    "var/lib/playops/claims",
    "var/lib/playops/write-intents",
    "var/lib/playops/release",
    "var/log/playops",
    "run/playops",
  ]) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    chmodSync(join(root, dir), 0o700);
  }
  mkdirSync(join(root, "etc/playops/credentials"), { recursive: true, mode: 0o750 });
  chmodSync(join(root, "etc/playops"), 0o750);
  chmodSync(join(root, "etc/playops/credentials"), 0o750);
  const credential = join(root, "etc/playops/credentials/google-play.json");
  writeFileSync(credential, "{}\n", { mode: 0o640 });
  chmodSync(credential, 0o640);
  const configPath = join(root, "etc/playops/playops.yaml");
  writeFileSync(configPath, remappedExample(root), { mode: 0o640 });
  chmodSync(configPath, 0o640);
  return configPath;
}

describe("Stage 4C.4 production startup contract", () => {
  it("constructs the production composition from the example + declared layout with zero network and no socket bind", async () => {
    const root = tempRoot();
    const configPath = provision(root);
    const { privateKey } = generateKeyPairSync("ed25519");
    const publicKey = createPublicKey(privateKey as KeyObject);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const application = await createProductionDaemonApplication({
        configPath,
        env: {},
        trustPolicy: TEST_POLICY,
        factories: {
          loadCredentials: (): ServiceAccountCredentials => ({
            type: "service_account",
            clientEmail: "synthetic@example.invalid",
            privateKey: "synthetic-test-material",
            tokenUri: "https://oauth2.googleapis.com/token",
            sourcePath: join(root, "etc/playops/credentials/google-play.json"),
          }),
          authenticate: (): GoogleAuthClient => ({}) as unknown as GoogleAuthClient,
          createPublisher: (): AndroidPublisherClient => ({}) as unknown as AndroidPublisherClient,
          createVerifier: () => createOperatorApprovalVerifier(publicKey, "stage-4c4-test-anchor"),
        },
      });

      expect(application.validated.packageName).toBe(VALID_PACKAGE);
      expect(application.validated.socketPath).toBe(join(root, "run/playops/playops.sock"));
      expect(application.validated.claimRoot).toBe(join(root, "var/lib/playops/claims"));
      expect(application.composition.servedOperationCount).toBe(10);
      expect(application.composition.socketMode).toBe(0o660);
      expect(application.composition.packageName).toBe(VALID_PACKAGE);
      expect(fetchSpy).not.toHaveBeenCalled();
      // Construction only: the socket was never bound.
      expect(() => lstatSync(join(root, "run/playops/playops.sock"))).toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

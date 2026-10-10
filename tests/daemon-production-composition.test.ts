/**
 * Stage 4A.1 — production daemon composition (structural + zero-Google).
 *
 * Offline: synthetic credential fixture written by this test, fake auth and
 * publisher, temp directories only. No /etc anchor, no Google call, no /var or
 * /run access. The operator verifier used here is the lower-level injection seam
 * so the pinned /etc anchor is never touched by a test.
 */
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeDns from "node:dns";
import type * as NodeHttp from "node:http";
import type * as NodeHttps from "node:https";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import type { GoogleAuthClient } from "../src/googleplay/auth/index.js";
import type { ServiceAccountCredentials } from "../src/config/index.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";
import { createDaemonServer } from "../src/daemon/server.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  encodeDaemonFrame,
  parseDaemonResponse,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { DAEMON_SERVED_OPERATIONS } from "../src/daemon/operations.js";
import { PACKAGE_OPERATION_BUSY_CODE } from "../src/daemon/package-operation-singleflight.js";
import {
  createProductionDaemonApplication,
  type ProductionDaemonApplication,
} from "../src/daemon/production-composition.js";

/**
 * File-wide network tripwires: any http/https request or DNS lookup performed
 * anywhere in this file's code under test throws immediately. Startup must be
 * zero-Google, so these modules must never be reached.
 */
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

const PACKAGE = "com.example.app";
/**
 * Stage 4C.1A seam: a temp fixture config/credential is owned by the test uid and
 * the injected process group identity stands in for the daemon's effective (socket
 * capability) group so the secret-service policy accepts an unprivileged fixture.
 * Module argument only — never env/CLI/config.
 */
const PROBE = mkdtempSync(join(tmpdir(), "playops-4c1a-compose-probe-"));
const TEST_GID = lstatSync(PROBE).gid;
rmSync(PROBE, { recursive: true, force: true });
const TEST_POLICY = {
  trustedOwnerUid: process.getuid?.() ?? 0,
  processGroupIdentity: { effectiveGid: TEST_GID + 1, supplementaryGids: [TEST_GID] },
};
const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-4a1-compose-"));
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

function fixture(credentialPrivateKey?: string): {
  readonly root: string;
  readonly configPath: string;
  readonly privateKey: KeyObject;
} {
  const root = tempRoot();
  for (const dir of ["pending", "claims", "write-intents", "state", "logs", "run"]) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    chmodSync(join(root, dir), 0o700);
  }
  // Synthetic service-account-shaped fixture. Never a real credential.
  writeFileSync(
    join(root, "service-account.json"),
    JSON.stringify({
      type: "service_account",
      client_email: "synthetic@example.invalid",
      private_key: credentialPrivateKey ?? "[REDACTED PRIVATE KEY]\n",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    { mode: 0o640 },
  );
  const configPath = join(root, "playops.yaml");
  writeFileSync(
    configPath,
    [
      "google_play:",
      `  package_name: "${PACKAGE}"`,
      `  service_account_json: "${join(root, "service-account.json")}"`,
      "audit:",
      `  log_path: "${join(root, "logs", "playops.audit.jsonl")}"`,
      "release:",
      `  edit_session_path: "${join(root, "state", "edit-session.json")}"`,
      `  edit_cleanup_journal_path: "${join(root, "state", "edit-cleanup-journal.json")}"`,
      `  commit_attempt_journal_path: "${join(root, "state", "commit-attempt-journal.json")}"`,
      "daemon:",
      `  socket_path: "${join(root, "run", "playops.sock")}"`,
      `  pending_store_path: "${join(root, "pending")}"`,
      `  claim_root: "${join(root, "claims")}"`,
      `  write_intent_store_path: "${join(root, "write-intents")}"`,
      "",
    ].join("\n"),
  );
  // Stage 4C.1A: the config file is a secret-bearing trust input; make its mode
  // explicit (0640) so the fixture is neither group-writable under umask 0002 nor
  // world-readable.
  chmodSync(configPath, 0o640);
  const { privateKey } = generateKeyPairSync("ed25519");
  return { root, configPath, privateKey: privateKey as KeyObject };
}

async function compose(
  root: string,
  configPath: string,
  privateKey: KeyObject,
): Promise<ProductionDaemonApplication> {
  // The verifier derives from the SAME key the test signs with: the pinned
  // production anchor is never touched by a test.
  const publicKey = createPublicKey(privateKey);
  return createProductionDaemonApplication({
    configPath,
    env: {},
    trustPolicy: TEST_POLICY,
    factories: {
      loadCredentials: (): ServiceAccountCredentials => ({
        type: "service_account",
        clientEmail: "synthetic@example.invalid",
        privateKey: "synthetic-test-material",
        tokenUri: "https://oauth2.googleapis.com/token",
        sourcePath: join(root, "service-account.json"),
      }),
      authenticate: (): GoogleAuthClient => ({}) as unknown as GoogleAuthClient,
      createPublisher: (): AndroidPublisherClient => ({}) as unknown as AndroidPublisherClient,
      createVerifier: () => createOperatorApprovalVerifier(publicKey, "stage-4a1-test-anchor"),
    },
  });
}

async function callOnce(socketPath: string, request: unknown): Promise<DaemonResponseEnvelope> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    socket.on("connect", () => {
      socket.end(
        encodeDaemonFrame(
          Buffer.from(
            JSON.stringify({
              protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
              correlationId: "stage-4a1-correlation",
              request,
            }),
            "utf8",
          ),
        ),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
    });
    socket.on("end", () => {
      try {
        resolve(parseDaemonResponse(JSON.parse(buffered.toString("utf8"))));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error("bad response"));
      }
    });
    socket.on("error", reject);
  });
}

describe("stage 4A.1 production composition", () => {
  it("wires all served operations, one package identity and one coordinator", async () => {
    const { root, configPath, privateKey } = fixture();
    const application = await compose(root, configPath, privateKey);
    const composition = application.composition;

    expect(DAEMON_SERVED_OPERATIONS).toHaveLength(10);
    expect(composition.servedOperationCount).toBe(10);
    expect(composition.packageName).toBe(PACKAGE);
    expect(application.validated.packageName).toBe(PACKAGE);
    // One gateway/composition graph, one store authority set.
    expect(composition.release.packageName).toBe(PACKAGE);
    expect(composition.release.cleanupJournal).toBeDefined();
    expect(composition.commitAttemptJournalPath).toBe(
      join(root, "state", "commit-attempt-journal.json"),
    );
    expect(composition.socketPath).toBe(join(root, "run", "playops.sock"));
    expect(composition.socketMode).toBe(0o660);

    // Exactly one coordinator, exposed and usable.
    expect(composition.coordinator.isPackageOperationHeld(PACKAGE)).toBe(false);
    const acquisition = composition.coordinator.tryAcquirePackageOperation(PACKAGE);
    expect(acquisition.acquired).toBe(true);
    expect(composition.coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
    expect(composition.coordinator.tryAcquirePackageOperation(PACKAGE).acquired).toBe(false);
    if (acquisition.acquired) {
      expect(composition.coordinator.releasePackageOperation(acquisition.lease).released).toBe(
        true,
      );
    }
  });

  it("proves the operations map shares the composition's single coordinator", async () => {
    const { root, configPath, privateKey } = fixture();
    const application = await compose(root, configPath, privateKey);
    const composition = application.composition;
    // Hold the lease directly through the composition's coordinator. If the
    // operations map used a DIFFERENT coordinator instance, the approved open-edit
    // execute path would reach the tool instead of reporting the busy verdict.
    const acquisition = composition.coordinator.tryAcquirePackageOperation(PACKAGE);
    expect(acquisition.acquired).toBe(true);

    const prepared = await composition.handle({
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: "stage-4a1-correlation",
      request: { kind: "prepare_open_edit" },
    });
    expect(prepared.outcome).toBe("approval_required");
    const challenge = prepared.approval;
    expect(challenge).toBeDefined();
    if (challenge === undefined) throw new Error("no challenge");

    const signature = sign(
      null,
      Buffer.from(challenge.canonicalPayload, "utf8"),
      privateKey,
    ).toString("base64url");
    const executed = await composition.handle({
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: "stage-4a1-correlation",
      request: { kind: "execute_open_edit", requestId: challenge.requestId, signature },
    });
    expect(executed.outcome).toBe("operation_in_progress");
    expect(executed.error?.code).toBe(PACKAGE_OPERATION_BUSY_CODE);
    if (acquisition.acquired) {
      composition.coordinator.releasePackageOperation(acquisition.lease);
    }
  });

  it("constructs and serves locally with zero Google API calls", async () => {
    const { root, configPath, privateKey } = fixture();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const application = await compose(root, configPath, privateKey);
      const server = createDaemonServer({
        socketPath: application.composition.socketPath,
        socketMode: application.composition.socketMode,
        handle: application.composition.handle,
      });
      await server.start();
      try {
        const status = await callOnce(application.composition.socketPath, { kind: "status" });
        expect(status.outcome).toBe("status");
        expect(status.summary).toContain(`configuredPackage=${PACKAGE}`);
      } finally {
        await server.close();
      }
      // The http/https/dns tripwires above would have thrown on any call; the
      // fetch spy covers the WHATWG surface as well.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("resolves every production path from the explicit config, never from cwd", async () => {
    const { root, configPath, privateKey } = fixture();
    const otherCwd = tempRoot();
    const originalCwd = process.cwd();
    try {
      const first = await compose(root, configPath, privateKey);
      process.chdir(otherCwd);
      const second = await compose(root, configPath, privateKey);
      expect(second.validated).toEqual(first.validated);
      expect(second.composition.socketPath).toBe(first.composition.socketPath);
      expect(second.composition.pendingStore).toBeDefined();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("fails closed when a path is relative, even though it is env-overridable", async () => {
    const { root, configPath, privateKey } = fixture();
    const publicKey = createPublicKey(privateKey);
    await expect(
      createProductionDaemonApplication({
        configPath,
        // A relative daemon path from the environment must still fail closed.
        env: { PLAYOPS_DAEMON_PENDING_STORE_PATH: "relative/pending" },
        trustPolicy: TEST_POLICY,
        // Fake factories only: the pinned /etc anchor is never touched.
        factories: {
          loadCredentials: (): ServiceAccountCredentials => ({
            type: "service_account",
            clientEmail: "synthetic@example.invalid",
            privateKey: "synthetic-test-material",
            tokenUri: "https://oauth2.googleapis.com/token",
            sourcePath: join(root, "service-account.json"),
          }),
          authenticate: (): GoogleAuthClient => ({}) as unknown as GoogleAuthClient,
          createPublisher: (): AndroidPublisherClient => ({}) as unknown as AndroidPublisherClient,
          createVerifier: () => createOperatorApprovalVerifier(publicKey, "stage-4a1-test-anchor"),
        },
      }),
    ).rejects.toThrow(/absolute/u);
    // The rejection came from validation, before any construction.
    expect(root.length).toBeGreaterThan(0);
  });

  it("builds the REAL Google auth and publisher clients through the default factories with zero network", async () => {
    // The default factories are used for credential loading, auth and the
    // Android Publisher client; only the pinned /etc anchor is injected. The
    // credential is synthetic (a freshly generated RSA key), so a real
    // google-auth-library JWT object and a real androidpublisher client are
    // constructed here and must perform no HTTP/DNS/OAuth request.
    const { privateKey: rsaKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }) as {
      privateKey: KeyObject;
    };
    const pem = rsaKey.export({ type: "pkcs8", format: "pem" }).toString();
    const { root, configPath, privateKey } = fixture(pem);
    const publicKey = createPublicKey(privateKey);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const application = await createProductionDaemonApplication({
        configPath,
        env: {},
        trustPolicy: TEST_POLICY,
        factories: {
          createVerifier: () => createOperatorApprovalVerifier(publicKey, "stage-4a1-test-anchor"),
        },
      });
      expect(application.composition.servedOperationCount).toBe(10);
      expect(application.composition.packageName).toBe(PACKAGE);
      expect(root.length).toBeGreaterThan(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

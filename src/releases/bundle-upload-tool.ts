import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  isReleaseEditSessionExpired,
  normalizeReleaseBundle,
  parseGooglePlayEditSession,
  parseReleaseEditSession,
  ReleaseError,
  toGooglePlayEditSession,
  validateReleasePackageName,
  type ReleaseBundle,
  type ReleaseEditSession,
} from "./index.js";
import type { ReleaseBundleUploadGateway } from "./gateway.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_UPLOAD_BUNDLE_TOOL_NAME = "releases.upload_bundle";

export interface ReleaseBundleUploadResult {
  /** Internal verifier binding; omitted from the model-facing result. */
  readonly editId: string;
  readonly expiryTimeSeconds: string;
  readonly versionCode: string;
  readonly sha256: string;
  readonly uploaded: true;
}

export interface ReleaseBundleUploadToolOptions {
  readonly packageName: string;
  /** Explicit operator/factory input. Never accepted from the model or global config. */
  readonly artifactPath: string;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly gateway: ReleaseBundleUploadGateway;
  readonly now?: () => Date;
}

export interface ReleaseBundleUploadTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseBundleUploadResult>;
  readonly binding: AgentToolBinding;
}

interface ArtifactSnapshot {
  readonly realPath: string;
  readonly size: bigint;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface ArtifactIdentity {
  readonly snapshot: ArtifactSnapshot;
  readonly sha256: string;
}

interface OpenArtifactStream {
  readonly handle: FileHandle;
  readonly body: ReadStream;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

function artifactNotFound(cause?: unknown): ReleaseError {
  return new ReleaseError("ARTIFACT_NOT_FOUND", "The supplied Android App Bundle was not found.", {
    ...(cause !== undefined ? { cause } : {}),
  });
}

function artifactInvalid(cause?: unknown): ReleaseError {
  return new ReleaseError("ARTIFACT_INVALID", "The supplied Android App Bundle is invalid.", {
    ...(cause !== undefined ? { cause } : {}),
  });
}

function artifactReadFailed(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "ARTIFACT_READ_FAILED",
    "The supplied Android App Bundle could not be read.",
    {
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

async function snapshotArtifact(path: string): Promise<ArtifactSnapshot> {
  let realPath: string;
  try {
    realPath = await realpath(path);
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT") || isErrnoCode(cause, "ENOTDIR")) {
      throw artifactNotFound(cause);
    }
    throw artifactReadFailed(cause);
  }

  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(realPath, { bigint: true });
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT") || isErrnoCode(cause, "ENOTDIR")) {
      throw artifactNotFound(cause);
    }
    throw artifactReadFailed(cause);
  }
  if (!details.isFile() || details.size <= 0n) throw artifactInvalid();

  return Object.freeze({
    realPath,
    size: details.size,
    device: details.dev,
    inode: details.ino,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  });
}

function sameSnapshot(left: ArtifactSnapshot, right: ArtifactSnapshot): boolean {
  return (
    left.realPath === right.realPath &&
    left.size === right.size &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function ensureSnapshotUnchanged(path: string, expected: ArtifactSnapshot): Promise<void> {
  let current: ArtifactSnapshot;
  try {
    current = await snapshotArtifact(path);
  } catch (cause) {
    throw new ReleaseError(
      "ARTIFACT_CHANGED",
      "The supplied Android App Bundle changed before upload.",
      {
        cause,
      },
    );
  }
  if (!sameSnapshot(expected, current)) {
    throw new ReleaseError(
      "ARTIFACT_CHANGED",
      "The supplied Android App Bundle changed before upload.",
    );
  }
}

async function openArtifactStream(snapshot: ArtifactSnapshot): Promise<OpenArtifactStream> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(snapshot.realPath, "r");
    const details = await handle.stat({ bigint: true });
    const opened: ArtifactSnapshot = {
      realPath: snapshot.realPath,
      size: details.size,
      device: details.dev,
      inode: details.ino,
      mtimeNs: details.mtimeNs,
      ctimeNs: details.ctimeNs,
    };
    if (!details.isFile() || !sameSnapshot(snapshot, opened)) {
      throw new ReleaseError(
        "ARTIFACT_CHANGED",
        "The supplied Android App Bundle changed before upload.",
      );
    }
    return { handle, body: handle.createReadStream({ autoClose: false }) };
  } catch (cause) {
    if (handle) await handle.close().catch(() => undefined);
    if (cause instanceof ReleaseError) throw cause;
    throw artifactReadFailed(cause);
  }
}

async function hashArtifact(path: string): Promise<ArtifactIdentity> {
  const initial = await snapshotArtifact(path);
  const hash = createHash("sha256");
  let bytesRead = 0n;
  try {
    for await (const chunk of createReadStream(initial.realPath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      hash.update(bytes);
      bytesRead += BigInt(bytes.byteLength);
    }
  } catch (cause) {
    throw artifactReadFailed(cause);
  }
  if (bytesRead !== initial.size) {
    throw new ReleaseError(
      "ARTIFACT_CHANGED",
      "The supplied Android App Bundle changed while hashing.",
    );
  }
  await ensureSnapshotUnchanged(path, initial);
  const sha256 = hash.digest("hex");
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw artifactReadFailed();
  return Object.freeze({ snapshot: initial, sha256 });
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) {
      throw new ReleaseError("INVALID_ARGUMENT", "Bundle upload input is invalid.");
    }
    return Object.freeze({});
  },
};

function createOutputSchema(packageName: string): ToolSchema<ReleaseBundleUploadResult> {
  return {
    parse(value: unknown): ReleaseBundleUploadResult {
      if (!isRecord(value)) {
        throw new ReleaseError("UPLOAD_RESPONSE_INVALID", "Bundle upload result is invalid.");
      }
      const keys = Object.keys(value).sort();
      const expected = ["editId", "expiryTimeSeconds", "sha256", "uploaded", "versionCode"];
      if (
        keys.length !== expected.length ||
        keys.some((key, index) => key !== expected[index]) ||
        value.uploaded !== true
      ) {
        throw new ReleaseError("UPLOAD_RESPONSE_INVALID", "Bundle upload result is invalid.");
      }
      const session = parseGooglePlayEditSession(
        {
          packageName,
          editId: value.editId,
          expiryTimeSeconds: value.expiryTimeSeconds,
        },
        packageName,
      );
      const bundle = normalizeReleaseBundle({
        versionCode: value.versionCode,
        sha256: value.sha256,
      });
      return Object.freeze({
        editId: session.editId,
        expiryTimeSeconds: session.expiryTimeSeconds ?? "",
        versionCode: bundle.versionCode,
        sha256: bundle.sha256,
        uploaded: true,
      });
    },
  };
}

function sessionInvalid(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "EDIT_SESSION_INVALID",
    "The tracked Google Play edit session could not be confirmed; open an edit explicitly if it was invalidated.",
    ...(cause !== undefined ? [{ cause }] : []),
  );
}

export function createReleaseBundleUploadTool(
  options: ReleaseBundleUploadToolOptions,
): ReleaseBundleUploadTool {
  const packageName = validateReleasePackageName(options?.packageName);
  if (typeof options?.artifactPath !== "string" || options.artifactPath.trim() === "") {
    throw artifactInvalid();
  }
  const artifactPath = resolve(options.artifactPath);
  if (extname(artifactPath) !== ".aab") throw artifactInvalid();
  const store = options?.sessionStore;
  const gateway = options?.gateway;
  const clock = options?.now ?? (() => new Date());
  if (!store || typeof store.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release edit session store is invalid.");
  }
  if (
    !gateway ||
    typeof gateway.getEdit !== "function" ||
    typeof gateway.uploadBundle !== "function" ||
    typeof gateway.listBundles !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Release bundle gateway is invalid.");
  }

  const description =
    "Upload the operator-supplied existing .aab file into the already-tracked Google Play edit. The artifact path, package, and edit id are bound outside model input. Requires a valid tracked edit session; it never creates an edit, changes a track, validates, commits, or publishes.";
  const outputSchema = createOutputSchema(packageName);

  const tool: ToolDefinition<Record<string, never>, ReleaseBundleUploadResult> = {
    name: RELEASES_UPLOAD_BUNDLE_TOOL_NAME,
    description,
    permission: "write",
    inputSchema,
    outputSchema,
    async execute(input) {
      inputSchema.parse(input);
      // Local artifact validation and streaming SHA-256 happen before any Google call.
      const artifact = await hashArtifact(artifactPath);
      const state = await loadReleaseEditSessionState(store, epochSecondsFromDate(clock));
      if (state.status === "none") {
        throw new ReleaseError(
          "EDIT_SESSION_REQUIRED",
          "No tracked Play edit session exists for this package; run releases.open_edit first.",
        );
      }
      if (state.status === "expired") {
        throw new ReleaseError(
          "EDIT_SESSION_EXPIRED",
          "The tracked Play edit session has expired; run releases.open_edit to open a new edit explicitly.",
        );
      }
      const session = parseReleaseEditSession(state.session, packageName);
      const googleSession = toGooglePlayEditSession(session);

      let remote;
      try {
        remote = await gateway.getEdit(googleSession);
      } catch (cause) {
        throw sessionInvalid(cause);
      }
      try {
        if (
          !isRecord(remote) ||
          remote.id !== session.editId ||
          typeof remote.expiryTimeSeconds !== "string" ||
          compareEpochSeconds(remote.expiryTimeSeconds, session.expiryTimeSeconds) !== 0
        ) {
          throw sessionInvalid();
        }
      } catch (cause) {
        if (cause instanceof ReleaseError && cause.code === "EDIT_SESSION_INVALID") throw cause;
        throw sessionInvalid(cause);
      }

      if (isReleaseEditSessionExpired(session, epochSecondsFromDate(clock))) {
        throw new ReleaseError(
          "EDIT_SESSION_EXPIRED",
          "The tracked Play edit session expired before upload; open a new edit explicitly.",
        );
      }
      await ensureSnapshotUnchanged(artifactPath, artifact.snapshot);

      const opened = await openArtifactStream(artifact.snapshot);
      const body = opened.body;
      let uploaded: unknown;
      try {
        uploaded = await gateway.uploadBundle(googleSession, { body });
      } catch (cause) {
        if (cause instanceof ReleaseError) throw cause;
        throw new ReleaseError(
          "UPLOAD_FAILED",
          "Google Play bundle upload failed; remote edit state may be uncertain.",
          { cause },
        );
      } finally {
        if (!body.destroyed) body.destroy();
        await finished(body).catch(() => undefined);
        await opened.handle.close().catch(() => undefined);
      }

      let bundle: ReleaseBundle;
      try {
        bundle = normalizeReleaseBundle(uploaded);
      } catch (cause) {
        throw new ReleaseError(
          "UPLOAD_RESPONSE_INVALID",
          "Google accepted or may have accepted the upload, but returned invalid bundle metadata.",
          { cause },
        );
      }
      if (bundle.sha256 !== artifact.sha256) {
        throw new ReleaseError(
          "UPLOAD_RESPONSE_INVALID",
          "Google-reported bundle SHA-256 does not match the supplied artifact; remote state may be uncertain.",
          { cause: new Error("Uploaded bundle hash differs from the local artifact hash.") },
        );
      }
      return Object.freeze({
        editId: session.editId,
        expiryTimeSeconds: session.expiryTimeSeconds,
        versionCode: bundle.versionCode,
        sha256: bundle.sha256,
        uploaded: true,
      });
    },
    async verify(_input, output) {
      const result = outputSchema.parse(output);
      let tracked: ReleaseEditSession | undefined;
      try {
        const current = await store.load();
        if (current !== undefined) tracked = parseReleaseEditSession(current, packageName);
      } catch {
        return false;
      }
      if (
        !tracked ||
        tracked.packageName !== packageName ||
        tracked.editId !== result.editId ||
        tracked.expiryTimeSeconds !== result.expiryTimeSeconds
      ) {
        return false;
      }
      let remoteBundles: readonly ReleaseBundle[];
      try {
        remoteBundles = await gateway.listBundles(toGooglePlayEditSession(tracked));
      } catch {
        return false;
      }
      if (!Array.isArray(remoteBundles)) return false;
      try {
        return remoteBundles
          .map((bundle) => normalizeReleaseBundle(bundle))
          .some(
            (bundle) =>
              bundle.versionCode === result.versionCode && bundle.sha256 === result.sha256,
          );
      } catch {
        return false;
      }
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_UPLOAD_BUNDLE_TOOL_NAME,
    llm: {
      name: RELEASES_UPLOAD_BUNDLE_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.permission !== "write" ||
        verification.required !== true ||
        verification.verified !== true
      ) {
        throw new ReleaseError("UPLOAD_RESPONSE_INVALID", "Bundle upload result was not verified.");
      }
      return JSON.stringify({
        versionCode: result.versionCode,
        sha256: result.sha256,
        uploaded: true,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

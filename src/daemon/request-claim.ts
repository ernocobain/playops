/**
 * Exclusive per-request execution claim (privilege-separated operator path).
 *
 * A signed approval may be executed at most once. This primitive is the
 * local-filesystem gate that enforces it: claiming uses `open(path, "wx")`
 * (O_EXCL) so exactly one process can hold a given request, and a second
 * claimant fails closed.
 *
 * Crash semantics are deliberately conservative. A claim is never stolen, never
 * expired, and never reclaimed because its recorded process is gone: the file
 * is only ever removed by an explicit `releaseRequestClaim` carrying the token
 * held by the claimant. A claim left behind by a crash therefore remains as
 * explicit "claimed / uncertain" evidence that a later, operator-driven
 * reconcile step may inspect. The safety preference is a false negative on
 * availability over any chance of double execution.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export const REQUEST_CLAIM_SCHEMA_VERSION = 1;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type RequestClaimErrorCode =
  | "CLAIM_ALREADY_HELD"
  | "CLAIM_NOT_HELD"
  | "CLAIM_RELEASE_DENIED"
  | "CLAIM_REQUEST_ID_INVALID"
  | "CLAIM_FILE_INVALID"
  | "CLAIM_STORE_INSECURE";

export class RequestClaimError extends Error {
  override readonly name = "RequestClaimError";

  constructor(
    readonly code: RequestClaimErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface RequestClaim {
  readonly requestId: string;
  /** Store root the claim lives under; carried so release needs no re-derivation. */
  readonly rootDir: string;
  readonly path: string;
  readonly claimedAtUtc: string;
  readonly pid: number;
  /** Held in memory only. The claim file stores just its SHA-256 digest. */
  readonly token: string;
}

export type RequestClaimInspection =
  | { readonly status: "absent" }
  | {
      readonly status: "held";
      readonly requestId: string;
      readonly claimedAtUtc: string;
      readonly pid: number;
    };

interface RequestClaimFile {
  readonly schemaVersion: number;
  readonly requestId: string;
  readonly claimedAtUtc: string;
  readonly pid: number;
  readonly tokenDigest: string;
}

const CLAIM_FILE_KEYS: readonly string[] = Object.freeze([
  "schemaVersion",
  "requestId",
  "claimedAtUtc",
  "pid",
  "tokenDigest",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(cause: unknown, code: string): boolean {
  return isRecord(cause) && cause.code === code;
}

function digestToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function assertRequestId(requestId: string): string {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new RequestClaimError(
      "CLAIM_REQUEST_ID_INVALID",
      "Claim request identifier is not a canonical identifier.",
    );
  }
  return requestId;
}

function claimFileInvalid(detail: string): RequestClaimError {
  return new RequestClaimError("CLAIM_FILE_INVALID", `Request claim file is invalid: ${detail}`);
}

function parseClaimFile(value: unknown): RequestClaimFile {
  if (!isRecord(value)) throw claimFileInvalid("expected an object");
  for (const key of Object.keys(value)) {
    if (!CLAIM_FILE_KEYS.includes(key)) throw claimFileInvalid(`unknown field "${key}"`);
  }
  if (value.schemaVersion !== REQUEST_CLAIM_SCHEMA_VERSION) {
    throw claimFileInvalid("unsupported schema version");
  }
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) {
    throw claimFileInvalid("requestId is invalid");
  }
  if (typeof value.claimedAtUtc !== "string" || Number.isNaN(Date.parse(value.claimedAtUtc))) {
    throw claimFileInvalid("claimedAtUtc is invalid");
  }
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
    throw claimFileInvalid("pid is invalid");
  }
  if (typeof value.tokenDigest !== "string" || !DIGEST_PATTERN.test(value.tokenDigest)) {
    throw claimFileInvalid("tokenDigest is invalid");
  }
  return {
    schemaVersion: REQUEST_CLAIM_SCHEMA_VERSION,
    requestId: value.requestId,
    claimedAtUtc: value.claimedAtUtc,
    pid: value.pid,
    tokenDigest: value.tokenDigest,
  };
}

async function assertPrivateStore(rootDir: string): Promise<void> {
  const stats = await lstat(rootDir);
  if (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700) {
    throw new RequestClaimError(
      "CLAIM_STORE_INSECURE",
      "Claim directory must be a private 0700 directory.",
    );
  }
}

/** Path of the claim file for one request. Validates the id before any path use. */
export function requestClaimPath(rootDir: string, requestId: string): string {
  return join(rootDir, `${assertRequestId(requestId)}.claim`);
}

export interface AcquireClaimOptions {
  readonly now?: () => Date;
  readonly pid?: number;
  readonly token?: () => string;
}

/**
 * Attempt to claim one request. Succeeds for exactly one caller; every other
 * concurrent or later caller fails closed with `CLAIM_ALREADY_HELD`.
 */
export async function acquireRequestClaim(
  rootDir: string,
  requestId: string,
  options: AcquireClaimOptions = {},
): Promise<RequestClaim> {
  const path = requestClaimPath(rootDir, requestId);
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await assertPrivateStore(rootDir);

  const clock = options.now ?? ((): Date => new Date());
  const token = (options.token ?? ((): string => randomBytes(32).toString("base64url")))();
  const file: RequestClaimFile = {
    schemaVersion: REQUEST_CLAIM_SCHEMA_VERSION,
    requestId,
    claimedAtUtc: clock().toISOString(),
    pid: options.pid ?? process.pid,
    tokenDigest: digestToken(token),
  };

  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (cause) {
    if (isErrno(cause, "EEXIST")) {
      throw new RequestClaimError(
        "CLAIM_ALREADY_HELD",
        "This approval request has already been claimed by another execution.",
        { cause },
      );
    }
    throw cause;
  }
  try {
    await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (cause) {
    // Never leave a half-written claim behind to block a legitimate retry.
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw cause;
  } finally {
    await handle.close().catch(() => undefined);
  }

  const directory = await open(rootDir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }

  return Object.freeze({
    requestId,
    rootDir,
    path,
    claimedAtUtc: file.claimedAtUtc,
    pid: file.pid,
    token,
  });
}

/** Inspect a claim without ever creating, stealing, expiring or removing it. */
export async function inspectRequestClaim(
  rootDir: string,
  requestId: string,
): Promise<RequestClaimInspection> {
  const path = requestClaimPath(rootDir, requestId);
  await assertPrivateStore(rootDir).catch((cause: unknown) => {
    if (isErrno(cause, "ENOENT")) return;
    throw cause;
  });
  let stats;
  try {
    stats = await lstat(path);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return { status: "absent" };
    throw cause;
  }
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
    throw new RequestClaimError(
      "CLAIM_STORE_INSECURE",
      "Request claim file must be a private 0600 regular file.",
    );
  }
  const parsed = parseClaimFile(JSON.parse(await readFile(path, "utf8")) as unknown);
  return {
    status: "held",
    requestId: parsed.requestId,
    claimedAtUtc: parsed.claimedAtUtc,
    pid: parsed.pid,
  };
}

/**
 * Explicit release by the claimant only. Requires the in-memory token, so a
 * different process cannot clear a claim it did not take.
 */
export async function releaseRequestClaim(claim: RequestClaim): Promise<void> {
  const path = requestClaimPath(claim.rootDir, claim.requestId);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      throw new RequestClaimError("CLAIM_NOT_HELD", "No request claim is held.");
    }
    throw cause;
  }
  const parsed = parseClaimFile(JSON.parse(contents) as unknown);
  if (!digestsEqual(parsed.tokenDigest, digestToken(claim.token))) {
    throw new RequestClaimError(
      "CLAIM_RELEASE_DENIED",
      "Request claim release was denied: the claim token does not match.",
    );
  }
  await unlink(path);
}

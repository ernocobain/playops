/**
 * Phase 4.2 — managed Play edit session store.
 *
 * Why this exists: creating a new Google Play edit invalidates any other edit the
 * same API user already has open for the same application (see PLAYOPS_PLAN.md
 * §3/§4.2). A transient, invisible edit created inside a read command can therefore
 * discard uncommitted work, so the edit identity must be tracked explicitly and
 * survive across commands instead of being recreated on demand.
 *
 * File store: caller-supplied path, Node built-ins only, atomic replace
 * (temp file → fsync → rename) so a partially written file can never become the
 * accepted session.
 *
 * CONCURRENCY LIMITATION (single-process, single-operator CLI): atomic replacement
 * protects against partial/torn files, but it does NOT provide multi-process
 * distributed locking. Two PlayOps processes sharing one session file can race;
 * no lock or database is introduced.
 *
 * Malformed or unsupported state fails safely and is never silently overwritten.
 */
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  isReleaseEditSessionExpired,
  parseReleaseEditSession,
  ReleaseError,
  type ReleaseEditSession,
} from "./index.js";

export interface ReleaseEditSessionStore {
  /** `undefined` when no session is tracked yet. Throws when tracked state is unusable. */
  load(): Promise<ReleaseEditSession | undefined>;
  /** Atomically persists one validated session (replacing any previous session). */
  save(session: ReleaseEditSession): Promise<void>;
  /** Removes tracked state. Test/infrastructure use; no user-facing CLI action in 4.2. */
  clear(): Promise<void>;
}

export interface ReleaseEditSessionStoreOptions {
  /**
   * Composition-bound package. When supplied, tracked state for a different
   * application is refused rather than reused or replaced.
   */
  readonly expectedPackageName?: string;
}

/** Tracked-session classification shared by the open and inspect tools. */
export type ReleaseEditSessionState =
  | { readonly status: "none" }
  | { readonly status: "active"; readonly session: ReleaseEditSession }
  | { readonly status: "expired"; readonly session: ReleaseEditSession };

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export function createFileReleaseEditSessionStore(
  path: string,
  options: ReleaseEditSessionStoreOptions = {},
): ReleaseEditSessionStore {
  if (typeof path !== "string" || path.trim() === "") {
    throw new ReleaseError("INVALID_ARGUMENT", "Edit session path must be a non-empty string.");
  }
  const expectedPackageName = options?.expectedPackageName;
  if (expectedPackageName !== undefined && typeof expectedPackageName !== "string") {
    throw new ReleaseError("INVALID_ARGUMENT", "Edit session package binding is invalid.");
  }

  const validate = (session: unknown): ReleaseEditSession => {
    if (expectedPackageName !== undefined) {
      return parseReleaseEditSession(session, expectedPackageName);
    }
    if (typeof session !== "object" || session === null || Array.isArray(session)) {
      throw new ReleaseError("EDIT_SESSION_STORE_INVALID", "Tracked edit session is invalid.");
    }
    const candidate = (session as { packageName?: unknown }).packageName;
    if (typeof candidate !== "string") {
      throw new ReleaseError("EDIT_SESSION_STORE_INVALID", "Tracked edit session is invalid.");
    }
    return parseReleaseEditSession(session, candidate);
  };

  return Object.freeze({
    async load(): Promise<ReleaseEditSession | undefined> {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (cause) {
        if (isErrnoCode(cause, "ENOENT")) return undefined;
        throw new ReleaseError(
          "EDIT_SESSION_STORE_INVALID",
          "Tracked edit session could not be read.",
          { cause },
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (cause) {
        throw new ReleaseError(
          "EDIT_SESSION_STORE_INVALID",
          "Tracked edit session is not valid JSON.",
          { cause },
        );
      }
      return validate(json);
    },

    async save(session: ReleaseEditSession): Promise<void> {
      const validated = validate(session);
      const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        const handle = await open(tempPath, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tempPath, path);
      } catch (cause) {
        await unlink(tempPath).catch(() => undefined);
        throw new ReleaseError(
          "EDIT_SESSION_WRITE_FAILED",
          "Tracked edit session could not be written.",
          { cause },
        );
      }
    },

    async clear(): Promise<void> {
      try {
        await unlink(path);
      } catch (cause) {
        if (isErrnoCode(cause, "ENOENT")) return;
        throw new ReleaseError(
          "EDIT_SESSION_WRITE_FAILED",
          "Tracked edit session could not be cleared.",
          { cause },
        );
      }
    },
  });
}

/**
 * Classify tracked state without mutating it. `nowSeconds` is supplied by the
 * caller (injectable clock) so expiry decisions stay deterministic in tests.
 */
export async function loadReleaseEditSessionState(
  store: ReleaseEditSessionStore,
  nowSeconds: string,
): Promise<ReleaseEditSessionState> {
  if (!store || typeof store.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Edit session store is required.");
  }
  const session = await store.load();
  if (session === undefined) return Object.freeze({ status: "none" });
  if (isReleaseEditSessionExpired(session, nowSeconds)) {
    return Object.freeze({ status: "expired", session });
  }
  return Object.freeze({ status: "active", session });
}

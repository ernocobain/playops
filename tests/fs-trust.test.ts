/**
 * Stage 4C.1 — shared filesystem-trust helper.
 *
 * Two layers: a fully deterministic fake port for every refusal/acceptance
 * branch, and a real `nodeFsTrustPort` block that exercises the actual
 * `node:fs` open/`fstat`/read sequence against temp fixtures only (never a host
 * path). No credential, network or Google access.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FS_TRUST_MAX_BYTES,
  FsTrustError,
  publicIntegrityFilePolicy,
  readTrustedRegularFile,
  SECRET_SERVICE_ALLOWED_MODES,
  secretServiceFilePolicy,
  TRUSTED_SYSTEM_UID,
  type FsTrustMetadata,
  type FsTrustPolicy,
  type FsTrustPort,
} from "../src/shared/fs-trust.js";

const LEAF = "/etc/playops/operator-approval.pub";
const PARENT = "/etc/playops";

interface FakeNode {
  readonly meta: FsTrustMetadata;
  readonly content?: string;
  readonly raw?: Buffer;
}

function fakeMetadata(overrides: Partial<FsTrustMetadata> = {}): FsTrustMetadata {
  return {
    uid: TRUSTED_SYSTEM_UID,
    gid: 0,
    mode: 0o100644,
    size: 0,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    ...overrides,
  };
}

function fakePort(
  nodes: Record<string, FakeNode>,
  options: { readonly directoryDescriptorUnsupported?: boolean } = {},
): FsTrustPort {
  const open = new Map<number, FakeNode>();
  let nextFd = 3;
  const openNode = (path: string): number => {
    const node = nodes[path];
    if (node === undefined) throw new FsTrustError("TRUST_UNREADABLE", `fake: missing ${path}`);
    if (node.meta.isSymbolicLink)
      throw new FsTrustError("TRUST_PATH_UNSAFE", `fake: symlink ${path}`);
    const fd = nextFd;
    nextFd += 1;
    open.set(fd, node);
    return fd;
  };
  return {
    lstat: (path) => nodes[path]?.meta,
    openReadNoFollow: (path) => openNode(path),
    openDirectoryNoFollow: (path) =>
      options.directoryDescriptorUnsupported === true ? undefined : openNode(path),
    fstat: (fd) => {
      const node = open.get(fd);
      if (node === undefined) throw new FsTrustError("TRUST_UNREADABLE", `fake: bad fd`);
      return node.meta;
    },
    readAll: (fd, limit) => {
      const node = open.get(fd);
      const bytes = node?.raw ?? Buffer.from(node?.content ?? "", "utf8");
      return bytes.subarray(0, limit + 1);
    },
    close: (fd) => {
      open.delete(fd);
    },
  };
}

function trustedParent(overrides: Partial<FsTrustMetadata> = {}): FakeNode {
  return {
    meta: fakeMetadata({ mode: 0o40755, isFile: false, isDirectory: true, ...overrides }),
  };
}

function nodes(
  leaf: FakeNode,
  parent: FakeNode | null = trustedParent(),
): Record<string, FakeNode> {
  const map: Record<string, FakeNode> = { [LEAF]: leaf };
  if (parent !== null) map[PARENT] = parent;
  return map;
}

function textLeaf(content: string, overrides: Partial<FsTrustMetadata> = {}): FakeNode {
  return {
    meta: fakeMetadata({ mode: 0o100644, size: Buffer.byteLength(content), ...overrides }),
    content,
  };
}

function expectTrustError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected an FsTrustError");
  } catch (cause) {
    expect(cause).toBeInstanceOf(FsTrustError);
    expect((cause as FsTrustError).code).toBe(code);
  }
}

describe("fs-trust helper (fake port)", () => {
  it("accepts a root-owned, non-writable regular file in a trusted parent", () => {
    const text = readTrustedRegularFile(LEAF, {
      port: fakePort(nodes(textLeaf("SECURE"))),
      policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
    });
    expect(text).toBe("SECURE");
  });

  it("refuses a leaf owned by a different uid", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(textLeaf("SECURE", { uid: 1000 }))),
          policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
        }),
      "TRUST_OWNER_UNSAFE",
    );
  });

  it("refuses a group- or other-writable leaf", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(textLeaf("SECURE", { mode: 0o100666 }))),
          policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
        }),
      "TRUST_MODE_UNSAFE",
    );
  });

  it("refuses a symlinked leaf before opening anything", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes({ meta: fakeMetadata({ isSymbolicLink: true }) })),
          policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
        }),
      "TRUST_PATH_UNSAFE",
    );
  });

  it("refuses a directory in the leaf position", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes({ meta: fakeMetadata({ isFile: false, isDirectory: true }) })),
          policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
        }),
      "TRUST_PATH_UNSAFE",
    );
  });

  it("refuses an over-large file at the size bound", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(textLeaf("12345"))),
          policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID, maxBytes: 4 },
        }),
      "TRUST_TOO_LARGE",
    );
  });

  it("refuses bytes that are not valid UTF-8", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(
            nodes({
              meta: fakeMetadata({ mode: 0o100644, size: 2 }),
              raw: Buffer.from([0xff, 0xfe]),
            }),
          ),
          policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
        }),
      "TRUST_NOT_UTF8",
    );
  });

  it("refuses an insecure parent directory", () => {
    const cases: readonly { readonly parent: FakeNode; readonly code: string }[] = [
      { parent: trustedParent({ mode: 0o40777 }), code: "TRUST_MODE_UNSAFE" },
      { parent: trustedParent({ mode: 0o40775 }), code: "TRUST_MODE_UNSAFE" },
      { parent: trustedParent({ uid: 5 }), code: "TRUST_OWNER_UNSAFE" },
      {
        parent: { meta: fakeMetadata({ isFile: false, isDirectory: true, isSymbolicLink: true }) },
        code: "TRUST_PATH_UNSAFE",
      },
      {
        parent: { meta: fakeMetadata({ isFile: true, isDirectory: false }) },
        code: "TRUST_PATH_UNSAFE",
      },
    ];
    for (const { parent, code } of cases) {
      expectTrustError(
        () =>
          readTrustedRegularFile(LEAF, {
            port: fakePort(nodes(textLeaf("SECURE"), parent)),
            policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
          }),
        code,
      );
    }
  });

  it("enforces exact allowedModes membership", () => {
    const accepted = readTrustedRegularFile(LEAF, {
      port: fakePort(nodes(textLeaf("SECURE", { mode: 0o100600 }))),
      policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID, allowedModes: [0o600] },
    });
    expect(accepted).toBe("SECURE");
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(textLeaf("SECURE", { mode: 0o100644 }))),
          policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID, allowedModes: [0o600] },
        }),
      "TRUST_MODE_UNSAFE",
    );
  });

  it("falls back to lstat when the platform has no directory descriptor", () => {
    const accepted = readTrustedRegularFile(LEAF, {
      port: fakePort(nodes(textLeaf("SECURE")), { directoryDescriptorUnsupported: true }),
      policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
    });
    expect(accepted).toBe("SECURE");
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(textLeaf("SECURE"), trustedParent({ mode: 0o40777 })), {
            directoryDescriptorUnsupported: true,
          }),
          policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
        }),
      "TRUST_MODE_UNSAFE",
    );
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(textLeaf("SECURE"), null), {
            directoryDescriptorUnsupported: true,
          }),
          policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
        }),
      "TRUST_PATH_UNSAFE",
    );
  });

  it("skips the parent check when verifyParent is false", () => {
    const text = readTrustedRegularFile(LEAF, {
      port: fakePort(nodes(textLeaf("SECURE"), null)),
      policy: { trustedOwnerUid: TRUSTED_SYSTEM_UID },
      verifyParent: false,
    });
    expect(text).toBe("SECURE");
  });

  it("exposes a positive default size bound", () => {
    expect(DEFAULT_FS_TRUST_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe("fs-trust named policies (Stage 4C.1A, fake port)", () => {
  const GROUP = 4242;
  const CAPABILITY = 4243;

  function secretPolicy(overrides: Partial<FsTrustPolicy> = {}): FsTrustPolicy {
    return secretServiceFilePolicy({
      processGroupIdentity: { effectiveGid: CAPABILITY, supplementaryGids: [GROUP] },
      ...overrides,
    });
  }

  function secretLeaf(mode: number, overrides: Partial<FsTrustMetadata> = {}): FakeNode {
    return textLeaf("SECRET", { gid: GROUP, mode: 0o100000 | mode, ...overrides });
  }

  function secretParent(overrides: Partial<FsTrustMetadata> = {}): FakeNode {
    return trustedParent({ gid: GROUP, mode: 0o40750, ...overrides });
  }

  it("separates the public-integrity and secret-service policies", () => {
    expect(publicIntegrityFilePolicy().trustedOwnerUid).toBe(TRUSTED_SYSTEM_UID);
    expect(publicIntegrityFilePolicy().secretConfidentiality).toBeUndefined();
    expect(publicIntegrityFilePolicy().allowedModes).toBeUndefined();
    expect(secretServiceFilePolicy().secretConfidentiality).toBe(true);
    expect(secretServiceFilePolicy().allowedModes).toEqual([0o640, 0o440]);
    expect(SECRET_SERVICE_ALLOWED_MODES).toEqual([0o640, 0o440]);
    // A root-owned 0644 public anchor is accepted by the public policy...
    expect(
      readTrustedRegularFile(LEAF, {
        port: fakePort(nodes(textLeaf("SECURE", { mode: 0o100644 }), trustedParent())),
        policy: publicIntegrityFilePolicy(),
      }),
    ).toBe("SECURE");
    // ...and the same mode is refused by the secret policy.
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(secretLeaf(0o644), secretParent())),
          policy: secretPolicy(),
        }),
      "TRUST_CONFIDENTIALITY_UNSAFE",
    );
  });

  it("accepts only 0640 and 0440 under the secret policy", () => {
    for (const mode of [0o640, 0o440]) {
      expect(
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(secretLeaf(mode), secretParent())),
          policy: secretPolicy(),
        }),
      ).toBe("SECRET");
    }
  });

  it("refuses world-readable, world-writable and loose leaf modes", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0o644, "TRUST_CONFIDENTIALITY_UNSAFE"],
      [0o444, "TRUST_CONFIDENTIALITY_UNSAFE"],
      [0o646, "TRUST_MODE_UNSAFE"],
      [0o660, "TRUST_MODE_UNSAFE"],
      [0o664, "TRUST_MODE_UNSAFE"],
      [0o666, "TRUST_MODE_UNSAFE"],
      [0o600, "TRUST_MODE_UNSAFE"],
      [0o400, "TRUST_MODE_UNSAFE"],
    ];
    for (const [mode, code] of cases) {
      expectTrustError(
        () =>
          readTrustedRegularFile(LEAF, {
            port: fakePort(nodes(secretLeaf(mode), secretParent())),
            policy: secretPolicy(),
          }),
        code,
      );
    }
  });

  it("refuses a leaf owned by the process effective (socket capability) group", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(secretLeaf(0o640, { gid: CAPABILITY }), secretParent())),
          policy: secretPolicy(),
        }),
      "TRUST_GROUP_IDENTITY_UNSAFE",
    );
  });

  it("refuses a parent owned by the process effective (socket capability) group", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(secretLeaf(0o640), secretParent({ gid: CAPABILITY }))),
          policy: secretPolicy(),
        }),
      "TRUST_GROUP_IDENTITY_UNSAFE",
    );
  });

  it("refuses a leaf group that differs from the trusted parent group", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(secretLeaf(0o640), secretParent({ gid: GROUP + 7 }))),
          policy: secretPolicy(),
        }),
      "TRUST_GROUP_IDENTITY_UNSAFE",
    );
  });

  it("refuses a trusted secret group the process does not hold", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(secretLeaf(0o640), secretParent())),
          policy: secretPolicy({
            processGroupIdentity: { effectiveGid: CAPABILITY, supplementaryGids: [] },
          }),
        }),
      "TRUST_GROUP_IDENTITY_UNSAFE",
    );
  });

  it("skips only the supplementary-group comparison when getgroups is unavailable", () => {
    expect(
      readTrustedRegularFile(LEAF, {
        port: fakePort(nodes(secretLeaf(0o640), secretParent())),
        policy: secretPolicy({
          processGroupIdentity: { effectiveGid: CAPABILITY, supplementaryGids: undefined },
        }),
      }),
    ).toBe("SECRET");
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(secretLeaf(0o640), secretParent())),
          policy: secretPolicy({
            processGroupIdentity: { effectiveGid: GROUP, supplementaryGids: undefined },
          }),
        }),
      "TRUST_GROUP_IDENTITY_UNSAFE",
    );
  });

  it("requires a validated parent under the secret policy", () => {
    expectTrustError(
      () =>
        readTrustedRegularFile(LEAF, {
          port: fakePort(nodes(secretLeaf(0o640), null)),
          policy: secretPolicy(),
          verifyParent: false,
        }),
      "TRUST_GROUP_IDENTITY_UNSAFE",
    );
  });
});

describe("fs-trust helper (real node:fs port)", () => {
  const dirs: string[] = [];
  const currentUid = process.getuid?.() ?? 0;
  const policy = { trustedOwnerUid: currentUid };

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "playops-fs-trust-"));
    chmodSync(dir, 0o700);
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a real secure regular file through the descriptor", () => {
    const dir = tempDir();
    const file = join(dir, "anchor.pub");
    writeFileSync(file, "SECURE-REAL\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(readTrustedRegularFile(file, { policy })).toBe("SECURE-REAL\n");
  });

  it("refuses a real symlinked leaf", () => {
    const dir = tempDir();
    const target = join(dir, "real.pub");
    writeFileSync(target, "SECURE\n", { mode: 0o600 });
    const link = join(dir, "link.pub");
    symlinkSync(target, link);
    expectTrustError(() => readTrustedRegularFile(link, { policy }), "TRUST_PATH_UNSAFE");
  });

  it("refuses a real directory in the leaf position", () => {
    const dir = tempDir();
    const subdir = join(dir, "subdir");
    mkdirSync(subdir, { mode: 0o700 });
    expectTrustError(
      () => readTrustedRegularFile(subdir, { policy, verifyParent: false }),
      "TRUST_PATH_UNSAFE",
    );
  });

  it("refuses a real group-writable file and a real over-large file", () => {
    const dir = tempDir();
    const wide = join(dir, "wide.pub");
    writeFileSync(wide, "SECURE\n", { mode: 0o600 });
    chmodSync(wide, 0o666);
    expectTrustError(() => readTrustedRegularFile(wide, { policy }), "TRUST_MODE_UNSAFE");

    const large = join(dir, "large.pub");
    writeFileSync(large, "0123456789", { mode: 0o600 });
    chmodSync(large, 0o600);
    expectTrustError(
      () => readTrustedRegularFile(large, { policy: { ...policy, maxBytes: 3 } }),
      "TRUST_TOO_LARGE",
    );
  });

  it("refuses real invalid UTF-8 bytes", () => {
    const dir = tempDir();
    const file = join(dir, "binary.pub");
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
    chmodSync(file, 0o600);
    expectTrustError(() => readTrustedRegularFile(file, { policy }), "TRUST_NOT_UTF8");
  });
});

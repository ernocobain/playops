/**
 * Stage 2.4.2 — the shared release-notes track-state semantics.
 *
 * These tests pin three things against the production relation:
 *   - the exact equality (`sameReleaseNotesTrackState`) is release-order-sensitive
 *   - the digest agrees with that equality on every comparable fixture
 *   - the merge (`createExpectedReleaseNotesTrack`) preserves everything else
 *
 * Pure: no gateway, no I/O, no clock. No Google call, no tracks.update.
 */
import { describe, expect, it } from "vitest";
import { ReleaseError, type ReleaseState, type ReleaseTrackState } from "../src/releases/index.js";
import { createReleaseCommitStateDigest } from "../src/releases/commit-approval.js";
import {
  createExpectedReleaseNotesTrack,
  createReleaseNotesTrackStateDigest,
  sameReleaseNotesTrackState,
} from "../src/releases/release-notes-canonical.js";

const TRACK = "internal";

/** The release under test: multi-versionCode, multi-locale, every field populated. */
function targetRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: "42 (1.0)",
    // inProgress + userFraction is the consistent Google combination; a
    // `completed` release carrying a userFraction is rejected by the production
    // normalizer as REMOTE_DATA_INVALID.
    status: "inProgress",
    versionCodes: ["2", "3"],
    userFraction: 0.5,
    releaseNotes: [
      { language: "en-US", text: "English notes" },
      { language: "id-ID", text: "Catatan Indonesia" },
    ],
    countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
    inAppUpdatePriority: 3,
    ...overrides,
  };
}

/** An unrelated release that must survive every operation untouched. */
function otherRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: "41 (1.0)",
    status: "halted",
    versionCodes: ["41"],
    inAppUpdatePriority: 1,
    ...overrides,
  };
}

function trackOf(releases: readonly ReleaseState[]): ReleaseTrackState {
  return { track: TRACK, releases };
}

const A = trackOf([targetRelease(), otherRelease()]);
/** Same releases, swapped array order. */
const B = trackOf([otherRelease(), targetRelease()]);

function bothDigests(left: ReleaseTrackState, right: ReleaseTrackState): [string, string] {
  return [createReleaseNotesTrackStateDigest(left), createReleaseNotesTrackStateDigest(right)];
}

/** Equality and digest agreement are the "one semantic source" property. */
function expectAgreement(left: ReleaseTrackState, right: ReleaseTrackState): void {
  const equal = sameReleaseNotesTrackState(left, right);
  const [leftDigest, rightDigest] = bothDigests(left, right);
  expect(leftDigest === rightDigest).toBe(equal);
}

describe("release-notes track state: release order is significant", () => {
  it("treats a release-order permutation as unequal, and digests it differently", () => {
    expect(sameReleaseNotesTrackState(A, B)).toBe(false);
    expect(createReleaseNotesTrackStateDigest(A)).not.toBe(createReleaseNotesTrackStateDigest(B));
  });

  it("documents the commit-digest divergence that blocked Stage 3C", () => {
    // The commit canonicalization sorts releases, so it cannot see the swap...
    expect(createReleaseCommitStateDigest(A)).toBe(createReleaseCommitStateDigest(B));
    // ...while the notes relation and the notes digest both can.
    expect(sameReleaseNotesTrackState(A, B)).toBe(false);
    expect(createReleaseNotesTrackStateDigest(A)).not.toBe(createReleaseNotesTrackStateDigest(B));
    // The two digest domains must therefore remain separate.
    expect(createReleaseNotesTrackStateDigest(A)).not.toBe(createReleaseCommitStateDigest(A));
  });
});

describe("release-notes track state: versionCode set semantics", () => {
  it("treats a versionCode order permutation as equal, with equal digests", () => {
    const left = trackOf([targetRelease({ versionCodes: ["2", "3"] }), otherRelease()]);
    const right = trackOf([targetRelease({ versionCodes: ["3", "2"] }), otherRelease()]);

    // Derived from the production relation, not assumed.
    expect(sameReleaseNotesTrackState(left, right)).toBe(true);
    expect(createReleaseNotesTrackStateDigest(left)).toBe(
      createReleaseNotesTrackStateDigest(right),
    );
    expectAgreement(left, right);
  });

  it("is sensitive to a versionCode set change", () => {
    const left = trackOf([targetRelease({ versionCodes: ["2", "3"] }), otherRelease()]);
    const right = trackOf([targetRelease({ versionCodes: ["2", "4"] }), otherRelease()]);

    expect(sameReleaseNotesTrackState(left, right)).toBe(false);
    expect(createReleaseNotesTrackStateDigest(left)).not.toBe(
      createReleaseNotesTrackStateDigest(right),
    );
  });
});

describe("release-notes track state: note semantics", () => {
  const base = trackOf([targetRelease(), otherRelease()]);

  it("ignores note array order but not note content", () => {
    const reordered = trackOf([
      targetRelease({
        releaseNotes: [
          { language: "id-ID", text: "Catatan Indonesia" },
          { language: "en-US", text: "English notes" },
        ],
      }),
      otherRelease(),
    ]);
    expect(sameReleaseNotesTrackState(base, reordered)).toBe(true);
    expect(createReleaseNotesTrackStateDigest(base)).toBe(
      createReleaseNotesTrackStateDigest(reordered),
    );
  });

  it.each([
    [
      "one changed note",
      [
        { language: "en-US", text: "CHANGED" },
        { language: "id-ID", text: "Catatan Indonesia" },
      ],
    ],
    ["one missing locale", [{ language: "en-US", text: "English notes" }]],
    [
      "one added locale",
      [
        { language: "en-US", text: "English notes" },
        { language: "id-ID", text: "Catatan Indonesia" },
        { language: "ja-JP", text: "メモ" },
      ],
    ],
  ])("detects %s as unequal with a different digest", (_label, releaseNotes) => {
    const changed = trackOf([targetRelease({ releaseNotes }), otherRelease()]);
    expect(sameReleaseNotesTrackState(base, changed)).toBe(false);
    expect(createReleaseNotesTrackStateDigest(base)).not.toBe(
      createReleaseNotesTrackStateDigest(changed),
    );
  });

  it("keeps duplicate-language behavior exactly as the production relation has it", () => {
    const duplicated = trackOf([
      targetRelease({
        releaseNotes: [
          { language: "en-US", text: "English notes" },
          { language: "en-US", text: "English notes" },
        ],
      }),
      otherRelease(),
    ]);
    // Production behavior: duplicates make the relation answer false, even for
    // itself. Asserted, not "improved".
    expect(sameReleaseNotesTrackState(duplicated, duplicated)).toBe(false);
    expect(sameReleaseNotesTrackState(base, duplicated)).toBe(false);
    // A digest cannot mirror a non-reflexive relation, so it rejects the state —
    // the same stance the tool's round-trip clone already takes.
    expect(() => createReleaseNotesTrackStateDigest(duplicated)).toThrow(ReleaseError);
    try {
      createReleaseNotesTrackStateDigest(duplicated);
    } catch (cause) {
      expect((cause as ReleaseError).code).toBe("TRACK_STATE_NOT_ROUNDTRIPPABLE");
    }
  });
});

describe("release-notes track state: every other significant field", () => {
  const base = trackOf([targetRelease(), otherRelease()]);

  it.each([
    ["release name", { name: "42 (1.1)" }],
    ["release status", { status: "draft" as const }],
    ["userFraction presence", { userFraction: undefined }],
    ["userFraction value", { userFraction: 0.25 }],
    ["countryTargeting presence", { countryTargeting: undefined }],
    [
      "countryTargeting countries",
      { countryTargeting: { countries: ["US"], includeRestOfWorld: false } },
    ],
    [
      "countryTargeting includeRestOfWorld",
      { countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: true } },
    ],
    ["inAppUpdatePriority", { inAppUpdatePriority: 4 }],
    ["inAppUpdatePriority presence", { inAppUpdatePriority: undefined }],
  ])("is sensitive to %s", (_label, overrides) => {
    const changed = trackOf([targetRelease(overrides as Partial<ReleaseState>), otherRelease()]);
    expect(sameReleaseNotesTrackState(base, changed)).toBe(false);
    expect(createReleaseNotesTrackStateDigest(base)).not.toBe(
      createReleaseNotesTrackStateDigest(changed),
    );
    expectAgreement(base, changed);
  });

  it("is sensitive to track identity and to release count", () => {
    expect(sameReleaseNotesTrackState(base, { track: "beta", releases: A.releases })).toBe(false);
    expect(createReleaseNotesTrackStateDigest(base)).not.toBe(
      createReleaseNotesTrackStateDigest({ track: "beta", releases: A.releases }),
    );
    const shorter = trackOf([targetRelease()]);
    expect(sameReleaseNotesTrackState(base, shorter)).toBe(false);
    expect(createReleaseNotesTrackStateDigest(base)).not.toBe(
      createReleaseNotesTrackStateDigest(shorter),
    );
  });

  it("is sensitive to an unrelated release changing", () => {
    const changed = trackOf([targetRelease(), otherRelease({ name: "41 (1.1)" })]);
    expect(sameReleaseNotesTrackState(base, changed)).toBe(false);
    expect(createReleaseNotesTrackStateDigest(base)).not.toBe(
      createReleaseNotesTrackStateDigest(changed),
    );
  });

  it("agrees with itself for an identical track", () => {
    expect(sameReleaseNotesTrackState(base, base)).toBe(true);
    expectAgreement(base, trackOf([targetRelease(), otherRelease()]));
  });
});

describe("release-notes expected-track builder", () => {
  it("adds a locale, replacing only that release's notes", () => {
    const expected = createExpectedReleaseNotesTrack(A, 0, [
      { language: "en-US", text: "English notes" },
      { language: "id-ID", text: "Catatan Indonesia" },
      { language: "ja-JP", text: "メモ" },
    ]);

    expect(expected.releases[0]?.releaseNotes).toHaveLength(3);
    expect(expected.releases[0]?.releaseNotes?.at(-1)).toEqual({ language: "ja-JP", text: "メモ" });
    // Unrelated release untouched.
    expect(expected.releases[1]).toEqual(otherRelease());
  });

  it("replaces exactly the requested locale and preserves everything else", () => {
    const expected = createExpectedReleaseNotesTrack(A, 0, [
      { language: "en-US", text: "REPLACED" },
    ]);
    const target = expected.releases[0];

    expect(target?.releaseNotes).toEqual([{ language: "en-US", text: "REPLACED" }]);
    // Every other field of the target release is byte-preserved.
    expect(target?.name).toBe("42 (1.0)");
    expect(target?.status).toBe("inProgress");
    expect(target?.versionCodes).toEqual(["2", "3"]);
    expect(target?.userFraction).toBe(0.5);
    expect(target?.countryTargeting).toEqual({
      countries: ["US", "ID"],
      includeRestOfWorld: false,
    });
    expect(target?.inAppUpdatePriority).toBe(3);
    // Release identity, order and count preserved.
    expect(expected.track).toBe(TRACK);
    expect(expected.releases).toHaveLength(2);
    expect(expected.releases[1]?.name).toBe("41 (1.0)");
  });

  it("preserves release ORDER: the expected track is not sorted", () => {
    const expected = createExpectedReleaseNotesTrack(B, 1, [{ language: "en-US", text: "X" }]);
    expect(expected.releases[0]?.name).toBe("41 (1.0)");
    expect(expected.releases[1]?.name).toBe("42 (1.0)");
  });

  it("produces a state the equality relation recognises when re-applied identically", () => {
    const notes = [{ language: "en-US", text: "English notes" }];
    const once = createExpectedReleaseNotesTrack(A, 0, notes);
    const twice = createExpectedReleaseNotesTrack(once, 0, notes);
    expect(sameReleaseNotesTrackState(once, twice)).toBe(true);
    expect(createReleaseNotesTrackStateDigest(once)).toBe(
      createReleaseNotesTrackStateDigest(twice),
    );
    // And the expected state is distinguishable from the prior state.
    expect(sameReleaseNotesTrackState(A, once)).toBe(false);
  });
});

describe("release-notes canonical module: purity", () => {
  it("does not mutate its inputs and is deterministic", () => {
    const snapshot = JSON.stringify(A);
    const first = createReleaseNotesTrackStateDigest(A);
    const second = createReleaseNotesTrackStateDigest(A);
    const expected = createExpectedReleaseNotesTrack(A, 0, [{ language: "en-US", text: "X" }]);
    const expectedAgain = createExpectedReleaseNotesTrack(A, 0, [{ language: "en-US", text: "X" }]);

    expect(first).toBe(second);
    expect(JSON.stringify(A)).toBe(snapshot);
    expect(JSON.stringify(expected)).toBe(JSON.stringify(expectedAgain));
    expect(sameReleaseNotesTrackState(A, A)).toBe(true);
    // Inputs are never passed through by reference.
    expect(expected.releases[0]).not.toBe(A.releases[0]);
    expect(expected.releases).not.toBe(A.releases);
    expect(createReleaseNotesTrackStateDigest(A)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

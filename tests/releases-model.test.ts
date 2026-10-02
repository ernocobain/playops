import { describe, expect, it } from "vitest";
import {
  normalizeReleaseTracks,
  parseGooglePlayEditSession,
  RELEASE_STATUSES,
  ReleaseError,
} from "../src/releases/index.js";

const rawTrack = (overrides: Record<string, unknown> = {}) => ({
  track: "production",
  releases: [],
  ...overrides,
});

describe("release inspection normalization", () => {
  it("normalizes an empty tracks array", () => {
    expect(normalizeReleaseTracks([])).toEqual([]);
  });

  it("normalizes one track with no releases", () => {
    expect(normalizeReleaseTracks([rawTrack()])).toEqual([{ track: "production", releases: [] }]);
  });

  it("preserves version-code strings losslessly, including int64 values", () => {
    const codes = ["1", "9223372036854775807"];
    const [track] = normalizeReleaseTracks([
      rawTrack({ releases: [{ status: "completed", versionCodes: codes }] }),
    ]);

    expect(track?.releases[0]?.versionCodes).toEqual(codes);
    expect(track?.releases[0]?.versionCodes[1]).toBe("9223372036854775807");
  });

  it("preserves multiple releases in API order", () => {
    const [track] = normalizeReleaseTracks([
      rawTrack({
        releases: [
          { name: "newest", status: "inProgress", versionCodes: ["12"] },
          { name: "older", status: "completed", versionCodes: ["11"] },
        ],
      }),
    ]);

    expect(track?.releases.map((release) => release.name)).toEqual(["newest", "older"]);
  });

  it.each(RELEASE_STATUSES)("accepts documented release status %s", (status) => {
    const [track] = normalizeReleaseTracks([
      rawTrack({ releases: [{ status, versionCodes: [] }] }),
    ]);
    expect(track?.releases[0]?.status).toBe(status);
  });

  it("rejects unknown and missing release statuses", () => {
    for (const status of ["production", "ready", null, undefined, 1]) {
      expect(() =>
        normalizeReleaseTracks([rawTrack({ releases: [{ status, versionCodes: [] }] })]),
      ).toThrowError(ReleaseError);
    }
  });

  it("rejects userFraction on statuses where Google does not support it", () => {
    for (const status of ["statusUnspecified", "draft", "completed"]) {
      expect(() =>
        normalizeReleaseTracks([
          rawTrack({ releases: [{ status, versionCodes: ["4"], userFraction: 0.25 }] }),
        ]),
      ).toThrowError(ReleaseError);
    }
  });

  it("normalizes a staged rollout fraction and omits it when absent", () => {
    const [staged, completed] = normalizeReleaseTracks([
      rawTrack({
        releases: [
          { status: "inProgress", versionCodes: ["4"], userFraction: 0.05 },
          { status: "completed", versionCodes: ["3"], userFraction: null },
        ],
      }),
    ]);

    expect(staged?.releases[0]?.userFraction).toBe(0.05);
    expect(completed?.releases[1]?.userFraction).toBeUndefined();
  });

  it.each([0, 1, -0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "0.5"])(
    "rejects invalid userFraction %s",
    (userFraction) => {
      expect(() =>
        normalizeReleaseTracks([
          rawTrack({ releases: [{ status: "inProgress", versionCodes: [], userFraction }] }),
        ]),
      ).toThrowError(ReleaseError);
    },
  );

  it("normalizes BCP-47 release-note languages and preserves text/order", () => {
    const notes = [
      { language: "en-us", text: "Added a feature." },
      { language: "id-ID", text: "Perbaikan." },
    ];
    const [track] = normalizeReleaseTracks([
      rawTrack({ releases: [{ status: "completed", versionCodes: ["9"], releaseNotes: notes }] }),
    ]);

    expect(track?.releases[0]?.releaseNotes).toEqual([
      { language: "en-US", text: "Added a feature." },
      { language: "id-ID", text: "Perbaikan." },
    ]);
  });

  it("rejects malformed localized note data", () => {
    for (const releaseNotes of [
      "not-an-array",
      [null],
      [{}],
      [{ language: "not_a_tag", text: "x" }],
      [{ language: "en-US", text: 7 }],
    ]) {
      expect(() =>
        normalizeReleaseTracks([
          rawTrack({ releases: [{ status: "completed", versionCodes: [], releaseNotes }] }),
        ]),
      ).toThrowError(ReleaseError);
    }
  });

  it("rejects malformed version codes instead of coercing them", () => {
    for (const versionCodes of [
      [12],
      ["0"],
      ["01"],
      ["-1"],
      ["1.2"],
      ["9223372036854775808"],
      "12",
    ]) {
      expect(() =>
        normalizeReleaseTracks([rawTrack({ releases: [{ status: "completed", versionCodes }] })]),
      ).toThrowError(ReleaseError);
    }
  });

  it("rejects malformed track and release structures", () => {
    for (const track of [
      null,
      {},
      { track: "  ", releases: [] },
      { track: " internal ", releases: [] },
      { track: "internal track", releases: [] },
      rawTrack({ releases: {} }),
    ]) {
      expect(() => normalizeReleaseTracks([track])).toThrowError(ReleaseError);
    }
  });

  it("returns only PlayOps-owned fields and drops raw Google metadata", () => {
    const secretMarker = "RAW-GOOGLE-OBJECT-MARKER";
    const [result] = normalizeReleaseTracks([
      rawTrack({
        apiField: secretMarker,
        releases: [
          {
            name: "beta",
            status: "halted",
            versionCodes: ["8"],
            userFraction: 0.2,
            releaseNotes: [{ language: "en", text: "Hold rollout." }],
            hiddenTransport: secretMarker,
          },
        ],
      }),
    ]);

    expect(result).toEqual({
      track: "production",
      releases: [
        {
          name: "beta",
          status: "halted",
          versionCodes: ["8"],
          userFraction: 0.2,
          releaseNotes: [{ language: "en", text: "Hold rollout." }],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });
});

describe("temporary Google Play edit session validation", () => {
  it("keeps package and generated edit id bound with lossless expiry", () => {
    expect(
      parseGooglePlayEditSession(
        { packageName: "com.example.app", editId: "edit-a", expiryTimeSeconds: "9007199254740993" },
        "com.example.app",
      ),
    ).toEqual({
      packageName: "com.example.app",
      editId: "edit-a",
      expiryTimeSeconds: "9007199254740993",
    });
  });

  it.each([
    null,
    {},
    { packageName: "com.other.app", editId: "edit-a" },
    { packageName: "com.example.app", editId: " " },
    { packageName: "com.example.app", editId: "edit/a" },
    { packageName: "com.example.app", editId: "edit-a", expiryTimeSeconds: "tomorrow" },
  ])("rejects malformed or composition-mismatched session %j", (session) => {
    expect(() => parseGooglePlayEditSession(session, "com.example.app")).toThrowError(ReleaseError);
  });

  it("preserves an upstream cause without copying it into the safe error message", () => {
    const cause = new Error("PRIVATE-TRANSPORT-DETAIL");
    const error = new ReleaseError("EDIT_CREATE_FAILED", "Edit creation failed.", { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain("PRIVATE-TRANSPORT-DETAIL");
  });
});

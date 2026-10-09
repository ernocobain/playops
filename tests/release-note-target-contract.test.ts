/**
 * Stage 2.4.1 — pins the future `attach_notes` targeting contract.
 *
 * These tests assert that the agreed derivation and fail-closed rules are
 * recorded as assertable data, and that the conditions which depend on real
 * production constants are genuinely grounded in them. No derivation runs here
 * and no Google call is made.
 */
import { describe, expect, it } from "vitest";
import {
  RELEASE_CONFIGURATION_STATUSES,
  RELEASE_STATUSES,
  normalizeReleaseBundle,
} from "../src/releases/index.js";
import {
  RELEASE_NOTE_TARGET_DERIVATION_STEPS,
  RELEASE_NOTE_TARGET_FAIL_CLOSED_CONDITIONS,
  RELEASE_NOTE_TARGET_FORBIDDEN_HEURISTICS,
  RELEASE_NOTE_TARGET_VERSION_CODE_NOTE,
} from "../src/releases/release-note-target-contract.js";

describe("attach_notes targeting contract", () => {
  it("records the ten derivation steps, keyed on containment and the complete set", () => {
    expect(RELEASE_NOTE_TARGET_DERIVATION_STEPS).toHaveLength(10);
    for (const step of RELEASE_NOTE_TARGET_DERIVATION_STEPS) {
      expect(step.length).toBeGreaterThan(0);
    }
    const joined = RELEASE_NOTE_TARGET_DERIVATION_STEPS.join(" | ");
    // Release selection is by containment...
    expect(joined).toContain("CONTAINS");
    // ...but the configured release carries the release's COMPLETE set.
    expect(joined).toContain("COMPLETE canonical versionCode set");
    // The bundle is chosen by equality on the requested versionCode, and its
    // trusted digest material is used directly.
    expect(joined).toContain("equals the requested versionCode");
    expect(joined).toContain("sha256/sha1");
    // Presence/absence of userFraction must be preserved, not defaulted.
    expect(joined).toContain("preserving presence/absence");
  });

  it("names every unauthorised heuristic and uses none of them in the steps", () => {
    expect(RELEASE_NOTE_TARGET_FORBIDDEN_HEURISTICS).toHaveLength(5);
    // Exact casing, so the pinned list is matched literally.
    for (const banned of [
      "first release on the track",
      "last release on the track",
      "latest release on the track",
      "largest versionCode on the track",
      "using only the requested versionCode as configuredRelease.versionCodes",
    ]) {
      expect(RELEASE_NOTE_TARGET_FORBIDDEN_HEURISTICS).toContain(banned);
    }
    // The steps themselves must not encode any of them.
    const steps = RELEASE_NOTE_TARGET_DERIVATION_STEPS.join(" ").toLowerCase();
    for (const phrase of [
      "first release",
      "last release",
      "latest release",
      "largest versioncode",
      "only the requested versioncode",
    ]) {
      expect(steps).not.toContain(phrase);
    }
  });

  it("pins the eight fail-closed conditions with unique codes", () => {
    expect(RELEASE_NOTE_TARGET_FAIL_CLOSED_CONDITIONS).toHaveLength(8);
    const codes = RELEASE_NOTE_TARGET_FAIL_CLOSED_CONDITIONS.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of RELEASE_NOTE_TARGET_FAIL_CLOSED_CONDITIONS) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(codes).toEqual([
      "NO_MATCHING_RELEASE",
      "MULTIPLE_MATCHING_RELEASES",
      "RELEASE_NAME_ABSENT",
      "RELEASE_STATUS_HALTED",
      "RELEASE_STATUS_UNSPECIFIED",
      "NO_MATCHING_BUNDLE",
      "MULTIPLE_MATCHING_BUNDLES",
      "BUNDLE_NORMALIZATION_FAILED",
    ]);
  });

  it("grounds the status conditions in the real production status sets", () => {
    // Exactly the three configuration statuses the production tool can accept.
    expect(RELEASE_CONFIGURATION_STATUSES).toEqual(["draft", "inProgress", "completed"]);
    // Both halted and statusUnspecified are real track-release statuses that are
    // NOT configuration statuses, so no legal configuredRelease.status exists.
    expect(RELEASE_STATUSES).toContain("halted");
    expect(RELEASE_STATUSES).toContain("statusUnspecified");
    expect(RELEASE_CONFIGURATION_STATUSES).not.toContain("halted");
    expect(RELEASE_CONFIGURATION_STATUSES).not.toContain("statusUnspecified");
  });

  it("grounds the versionCode strictness note in the real bundle normalizer", () => {
    expect(RELEASE_NOTE_TARGET_VERSION_CODE_NOTE.length).toBeGreaterThan(0);
    // These are valid canonical decimal strings at the wire layer, but they can
    // never resolve to a trusted bundle, so derivation must fail closed.
    for (const versionCode of ["0", "007", "99999999999"]) {
      expect(() => normalizeReleaseBundle({ versionCode, sha256: "a".repeat(64) })).toThrow();
    }
    // A genuine bundle versionCode normalizes and preserves its trusted digest.
    expect(normalizeReleaseBundle({ versionCode: "42", sha256: "a".repeat(64) }).versionCode).toBe(
      "42",
    );
  });
});

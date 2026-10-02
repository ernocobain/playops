/**
 * Harness smoke test (Phase 0.4).
 *
 * Pure harness proof: exercises Vitest's expect/describe/it without touching
 * application behavior. Real modules are tested from Phase 0.5 onward.
 */
import { describe, expect, it } from "vitest";

describe("harness", () => {
  it("runs a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });
});

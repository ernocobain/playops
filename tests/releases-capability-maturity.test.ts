import { describe, expect, it, vi } from "vitest";

// The production policy is code-owned, not operator or model input.
describe("release capability maturity policy", () => {
  it("freezes exactly the three not-yet-hardened live capabilities", async () => {
    const { RELEASE_CAPABILITY_MATURITY } = await import("../src/releases/capability-maturity.js");
    expect(RELEASE_CAPABILITY_MATURITY).toEqual({
      "releases.update_rollout_fraction": "LIVE_BLOCKED_NOT_HARDENED",
      "releases.halt_rollout": "LIVE_BLOCKED_NOT_HARDENED",
      "releases.resume_rollout": "LIVE_BLOCKED_NOT_HARDENED",
    });
    expect(Object.keys(RELEASE_CAPABILITY_MATURITY)).toHaveLength(3);
    expect(Object.isFrozen(RELEASE_CAPABILITY_MATURITY)).toBe(true);
    expect(Reflect.set(RELEASE_CAPABILITY_MATURITY, "releases.halt_rollout", "LIVE_ALLOWED")).toBe(
      false,
    );
    expect(Reflect.set(RELEASE_CAPABILITY_MATURITY, "releases.commit_edit", "LIVE_ALLOWED")).toBe(
      false,
    );
  });
  it.each([
    "releases.update_rollout_fraction",
    "releases.halt_rollout",
    "releases.resume_rollout",
  ] as const)("rejects %s with an exact, safe capability error", async (toolName) => {
    const { assertReleaseCapabilityLiveAllowed, ReleaseCapabilityBlockedError } =
      await import("../src/releases/capability-maturity.js");
    let error: unknown;
    try {
      assertReleaseCapabilityLiveAllowed(toolName);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ReleaseCapabilityBlockedError);
    expect(error).toMatchObject({
      name: "ReleaseCapabilityBlockedError",
      code: "RELEASE_CAPABILITY_NOT_HARDENED",
      toolName,
      externalStateUncertain: false,
      message: "This release capability is not hardened for live execution.",
    });
    expect(error).not.toHaveProperty("cause");
  });

  it("never echoes an untrusted tool name in guard or error diagnostics", async () => {
    const { assertReleaseCapabilityLiveAllowed, ReleaseCapabilityBlockedError } =
      await import("../src/releases/capability-maturity.js");
    const secret = "/private/credential.json PRIVATE-KEY PRIVATE-NOTE PRIVATE-TOKEN";
    const untrustedName = secret as "releases.halt_rollout";
    for (const invoke of [
      () => assertReleaseCapabilityLiveAllowed(untrustedName),
      () => new ReleaseCapabilityBlockedError(untrustedName),
    ]) {
      let error: unknown;
      try {
        invoke();
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ message: "Release capability tool name is invalid." });
      expect(error).not.toHaveProperty("toolName");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("tests a LIVE_ALLOWED transition without overriding the production guard", async () => {
    const {
      RELEASE_CAPABILITY_MATURITY,
      isReleaseCapabilityLiveAllowed,
      assertReleaseCapabilityLiveAllowed,
      ReleaseCapabilityBlockedError,
    } = await import("../src/releases/capability-maturity.js");
    const transitionPolicy = Object.freeze({
      ...RELEASE_CAPABILITY_MATURITY,
      "releases.halt_rollout": "LIVE_ALLOWED" as const,
    });
    expect(Object.isFrozen(transitionPolicy)).toBe(true);
    expect(isReleaseCapabilityLiveAllowed("releases.halt_rollout", transitionPolicy)).toBe(true);
    expect(isReleaseCapabilityLiveAllowed("releases.resume_rollout", transitionPolicy)).toBe(false);
    expect(isReleaseCapabilityLiveAllowed("releases.halt_rollout")).toBe(false);
    expect(() =>
      Reflect.apply(assertReleaseCapabilityLiveAllowed, undefined, [
        "releases.halt_rollout",
        transitionPolicy,
      ]),
    ).toThrow(ReleaseCapabilityBlockedError);
    expect(RELEASE_CAPABILITY_MATURITY["releases.halt_rollout"]).toBe("LIVE_BLOCKED_NOT_HARDENED");
  });
  it("rejects coercible objects without echoing or coercing a non-string tool name", async () => {
    const { assertReleaseCapabilityLiveAllowed, ReleaseCapabilityBlockedError } =
      await import("../src/releases/capability-maturity.js");
    const untrusted = {
      toString: vi.fn(() => "releases.halt_rollout"),
      toJSON: vi.fn(() => "PRIVATE-TOOL-NAME-OBJECT"),
    };
    const toolName = untrusted as unknown as "releases.halt_rollout";
    for (const invoke of [
      () => assertReleaseCapabilityLiveAllowed(toolName),
      () => new ReleaseCapabilityBlockedError(toolName),
    ]) {
      let error: unknown;
      try {
        invoke();
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ message: "Release capability tool name is invalid." });
      expect(error).not.toHaveProperty("toolName");
      expect(String(error) + JSON.stringify(error)).not.toContain("PRIVATE-TOOL-NAME-OBJECT");
    }
    expect(untrusted.toString).not.toHaveBeenCalled();
    expect(untrusted.toJSON).not.toHaveBeenCalled();
  });
  it("does not accept a LIVE_ALLOWED value inherited outside the closed policy", async () => {
    const { assertReleaseCapabilityLiveAllowed } =
      await import("../src/releases/capability-maturity.js");
    const untrustedName = "releases.untrusted_capability";
    Object.defineProperty(Object.prototype, untrustedName, {
      value: "LIVE_ALLOWED",
      configurable: true,
    });
    try {
      expect(() =>
        assertReleaseCapabilityLiveAllowed(untrustedName as "releases.halt_rollout"),
      ).toThrow("Release capability tool name is invalid.");
    } finally {
      Reflect.deleteProperty(Object.prototype, untrustedName);
    }
  });
});

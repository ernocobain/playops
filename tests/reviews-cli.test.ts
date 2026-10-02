import { describe, expect, it } from "vitest";
import type { DoctorDeps } from "../src/doctor/doctor.js";
import { runCli } from "../src/cli/main.js";
import { parseReviewCommand } from "../src/cli/reviews.js";

describe("review CLI parser (command-driven, no publish flags)", () => {
  it("accepts only triage and a single explicit reply ID", () => {
    expect(parseReviewCommand(["triage"])).toEqual({ kind: "triage" });
    expect(parseReviewCommand(["reply", "gp:review_1"])).toEqual({
      kind: "reply",
      reviewId: "gp:review_1",
    });
  });
  it.each([[], ["--help"], ["triage", "--help"], ["reply", "--help"]].map((args) => ({ args })))(
    "supports help without any configuration or side effects: $args",
    ({ args }) => expect(parseReviewCommand(args)).toMatchObject({ kind: "help" }),
  );
  it.each(
    [
      ["reply"],
      ["reply", ""],
      ["reply", "  "],
      ["reply", "r1", "r2"],
      ["triage", "r1"],
      ["wrong"],
      ["reply", "r1", "--approve", "token"],
      ["reply", "r1", "--yes"],
      ["reply", "r1", "--force"],
      ["reply", "--help", "r1"],
    ].map((args) => ({ args })),
  )("rejects malformed or implicit-authority arguments: $args", ({ args }) => {
    expect(() => parseReviewCommand(args)).toThrowError(
      expect.objectContaining({ code: "CLI_ARGUMENT_INVALID" }),
    );
  });
});

describe("top-level CLI review command routing", () => {
  it("shows review help without loading credentials, checkpoint or provider", async () => {
    const logs: string[] = [],
      errors: string[] = [];
    const output = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
    const io = { write: output.log, writeError: output.error, isInteractive: false };
    const factory = async () => {
      throw new Error("MUST_NOT_COMPOSE");
    };
    expect(
      await runCli(["reviews", "--help"], {} as DoctorDeps, output, {
        io,
        compositionFactory: factory,
      }),
    ).toBe(0);
    expect(
      await runCli(["reviews", "triage", "--help"], {} as DoctorDeps, output, {
        io,
        compositionFactory: factory,
      }),
    ).toBe(0);
    expect(
      await runCli(["reviews", "reply", "--help"], {} as DoctorDeps, output, {
        io,
        compositionFactory: factory,
      }),
    ).toBe(0);
    expect(logs.join("\n")).toContain(
      "publishing creates/updates a public Google Play reply".replace("publishing", "Publishing"),
    );
    expect(errors).toEqual([]);
  });
  it("rejects unknown review arguments and shows reviews on root help", async () => {
    const logs: string[] = [],
      errors: string[] = [];
    const output = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
    expect(await runCli(["--help"], {} as DoctorDeps, output)).toBe(0);
    expect(logs.join("\n")).toContain("reviews");
    expect(await runCli(["reviews", "reply", "r1", "--force"], {} as DoctorDeps, output)).toBe(1);
    expect(errors.at(-1)).toMatch(/review/i);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import type { DoctorDeps } from "../src/doctor/doctor.js";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .version as string;

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      log: (text: string) => stdout.push(text),
      error: (text: string) => stderr.push(text),
    },
  };
}

describe("Stage 4C.4 installed version surface", () => {
  it("prints the installed package version for --version and -v and exits 0", async () => {
    for (const flag of ["--version", "-v"]) {
      const s = output();
      expect(await runCli([flag], {} as DoctorDeps, s.io)).toBe(0);
      expect(s.stdout).toEqual([`playops ${packageVersion}`]);
      expect(s.stderr).toEqual([]);
    }
  });

  it("keeps the flag exact: an extra argument stays an unknown-command error", async () => {
    const s = output();
    expect(await runCli(["--version", "extra"], {} as DoctorDeps, s.io)).toBe(1);
    expect(s.stdout).toEqual([]);
    expect(s.stderr).toEqual(['Unknown command or arguments. Run "playops --help".']);
  });

  it("advertises the flag in the help surface", async () => {
    const s = output();
    expect(await runCli(["--help"], {} as DoctorDeps, s.io)).toBe(0);
    expect(s.stdout.join("\n")).toContain("playops --version");
  });
});

/**
 * Stage 4C.1 — repository-owned deployment templates.
 *
 * Pure text assertions over the shipped unit and tmpfiles templates. Nothing is
 * installed, started or created: // these are templates only. systemd is never
 * touched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serviceText = readFileSync(
  fileURLToPath(new URL("../deploy/systemd/playops.service", import.meta.url)),
  "utf8",
);
const tmpfilesText = readFileSync(
  fileURLToPath(new URL("../deploy/tmpfiles.d/playops.conf", import.meta.url)),
  "utf8",
);

function sectionLines(text: string, name: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  expect(start).toBeGreaterThanOrEqual(0);
  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line.startsWith("[")) break;
    if (line !== "") collected.push(line);
  }
  return collected;
}

const EXPECTED_SERVICE = [
  "User=playops",
  "Group=playops-operator",
  "SupplementaryGroups=playops",
  "WorkingDirectory=/var/lib/playops",
  "ExecStart=/opt/playops/node24/bin/node /opt/playops/current/dist/daemon/main.js --config /etc/playops/playops.yaml",
  "RuntimeDirectory=playops",
  "RuntimeDirectoryMode=0750",
  "StateDirectory=playops",
  "StateDirectoryMode=0700",
  "LogsDirectory=playops",
  "LogsDirectoryMode=0700",
  "UMask=0077",
  "NoNewPrivileges=yes",
  "PrivateTmp=yes",
  "PrivateDevices=yes",
  "ProtectSystem=strict",
  "ProtectHome=yes",
  "ProtectKernelTunables=yes",
  "ProtectKernelModules=yes",
  "ProtectControlGroups=yes",
  "ProtectClock=yes",
  "ProtectHostname=yes",
  "RestrictSUIDSGID=yes",
  "LockPersonality=yes",
  "CapabilityBoundingSet=",
  "AmbientCapabilities=",
  "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  "Restart=on-failure",
  "RestartSec=5s",
];

describe("stage 4C.1 deployment templates", () => {
  it("unit declares the intended identity, paths, directories and hardening exactly", () => {
    const unit = serviceText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("After=systemd-tmpfiles-setup.service");
    expect(unit.some((line) => line.startsWith("Description="))).toBe(true);
    expect(unit).toContain("WantedBy=multi-user.target");
    // The [Service] block must be exactly the reviewed directive set.
    expect(sectionLines(serviceText, "Service")).toEqual(EXPECTED_SERVICE);
  });

  it("tokenizes ExecStart into exactly the four reviewed, space-separated tokens", () => {
    const execLine = serviceText
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("ExecStart="));
    expect(execLine).toBeDefined();
    const value = (execLine ?? "").slice("ExecStart=".length);
    expect(value.split(" ")).toEqual([
      "/opt/playops/node24/bin/node",
      "/opt/playops/current/dist/daemon/main.js",
      "--config",
      "/etc/playops/playops.yaml",
    ]);
    // Exactly four whitespace-separated tokens, and no accidental concatenation
    // such as `...node/opt/playops/node24/bin/node`.
    expect(value.split(/\s+/u).filter(Boolean)).toHaveLength(4);
    expect(value).not.toContain("node/opt/playops");
    expect(serviceText).not.toContain("node/opt/playops");
  });

  it("unit omits every forbidden or operator-writable directive, path and runtime", () => {
    const forbidden = [
      "PrivateNetwork=",
      "MemoryDenyWriteExecute=",
      "SystemCallFilter=",
      "EnvironmentFile=",
      "PassEnvironment=",
      "NODE_OPTIONS",
      "NODE_PATH",
      "/usr/bin/env",
      "/home/",
      "nvm",
      "RuntimeDirectoryPreserve=",
    ];
    for (const token of forbidden) {
      expect(serviceText).not.toContain(token);
    }
  });

  it("tmpfiles owns exactly the four nested 0700 state directories and nothing else", () => {
    const directives = tmpfilesText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(directives).toEqual([
      "d /var/lib/playops/pending 0700 playops playops-operator -",
      "d /var/lib/playops/claims 0700 playops playops-operator -",
      "d /var/lib/playops/write-intents 0700 playops playops-operator -",
      "d /var/lib/playops/release 0700 playops playops-operator -",
    ]);
    expect(tmpfilesText).not.toMatch(/^d\s+\/run/imu);
    expect(tmpfilesText).not.toMatch(/^d\s+\/var\/lib\/playops\s/imu);
    expect(tmpfilesText).not.toMatch(/^d\s+\/var\/log/imu);
  });
});

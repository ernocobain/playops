/**
 * Installed package version, read relative to the package root - never cwd,
 * never the environment. Every caller lives exactly two levels below the package
 * root (`src/shared/x.ts`, `dist/shared/x.js`, `src/daemon/x.ts`,
 * `dist/daemon/x.js`), so one relative lookup resolves to the installed manifest
 * in source, compiled and packed layouts alike.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readInstalledPackageVersion(): string | undefined {
  try {
    const manifest = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

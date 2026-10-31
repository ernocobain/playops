import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assertSafeRelativePath,
  EXECUTABLE_FILE_MODE,
  normalizePackageModes,
  ORDINARY_FILE_MODE,
} from "./normalize-package-modes.mjs";
import {
  APPROVED_PACKAGE_FIELDS,
  DEPLOYMENT_TEMPLATE_FILES,
  OPERATOR_DOC_FILES,
  REQUIRED_MODULE_FILES,
  ROOT_PAYLOAD_FILES,
  RUNTIME_DEPENDENCIES,
} from "./package-content.mjs";

const DECLARED_BIN_FILES = Object.freeze(Object.values(APPROVED_PACKAGE_FIELDS.bin).sort());
const STATIC_ORDINARY_FILES = Object.freeze([
  ...ROOT_PAYLOAD_FILES,
  ...OPERATOR_DOC_FILES,
  ...DEPLOYMENT_TEMPLATE_FILES,
]);
const ALL_REQUIRED_PUBLIC_FILES = Object.freeze([
  ...STATIC_ORDINARY_FILES,
  ...REQUIRED_MODULE_FILES,
]);
const ORDINARY_PUBLIC_FILES = Object.freeze(
  ALL_REQUIRED_PUBLIC_FILES.filter((relPath) => !DECLARED_BIN_FILES.includes(relPath)),
);

const INITIAL_ORDINARY_MODE = 0o750;
const INITIAL_BIN_MODE = 0o600;

function createValidMetadata(overrides = {}) {
  return {
    name: APPROVED_PACKAGE_FIELDS.name,
    version: "0.4.0",
    license: APPROVED_PACKAGE_FIELDS.license,
    private: APPROVED_PACKAGE_FIELDS.private,
    type: APPROVED_PACKAGE_FIELDS.type,
    engines: { ...APPROVED_PACKAGE_FIELDS.engines },
    bin: { ...APPROVED_PACKAGE_FIELDS.bin },
    files: [...APPROVED_PACKAGE_FIELDS.files],
    dependencies: { ...RUNTIME_DEPENDENCIES },
    scripts: { prepack: "npm run build && node scripts/normalize-package-modes.mjs" },
    ...overrides,
  };
}

function writeModeFile(rootDir, relPath, content, mode) {
  const fullPath = resolve(rootDir, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  chmodSync(fullPath, mode);
  return fullPath;
}

function readActualMode(rootDir, relPath) {
  return lstatSync(resolve(rootDir, relPath)).mode & 0o7777;
}

function createPackageFixture(t, options = {}) {
  const baseTmpDir = realpathSync(process.env.TMPDIR || tmpdir());
  const rootDir = realpathSync(mkdtempSync(join(baseTmpDir, "playops-e2a-")));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const metadata = createValidMetadata(options.metadataOverrides);
  const omitSet = new Set(options.omitFiles ?? []);

  for (const relPath of ALL_REQUIRED_PUBLIC_FILES) {
    if (omitSet.has(relPath)) {
      continue;
    }
    const isBin = DECLARED_BIN_FILES.includes(relPath);
    const initialMode = isBin ? INITIAL_BIN_MODE : INITIAL_ORDINARY_MODE;
    const defaultBytes =
      relPath === "package.json"
        ? Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8")
        : isBin
          ? Buffer.from(`#!/usr/bin/env node\nexport default ${JSON.stringify(relPath)};\n`, "utf8")
          : Buffer.from(`// payload: ${relPath}\n`, "utf8");
    const content = options.customContents?.[relPath] ?? defaultBytes;
    writeModeFile(rootDir, relPath, content, initialMode);
  }

  return { rootDir, metadata };
}

test("normalizes all ordinary public payload files to 0644 and declared bin entrypoints to 0755", (t) => {
  const { rootDir } = createPackageFixture(t);

  for (const relPath of ORDINARY_PUBLIC_FILES) {
    assert.equal(readActualMode(rootDir, relPath), INITIAL_ORDINARY_MODE);
    assert.notEqual(readActualMode(rootDir, relPath), ORDINARY_FILE_MODE);
  }
  for (const relPath of DECLARED_BIN_FILES) {
    assert.equal(readActualMode(rootDir, relPath), INITIAL_BIN_MODE);
    assert.notEqual(readActualMode(rootDir, relPath), EXECUTABLE_FILE_MODE);
  }

  const result = normalizePackageModes(rootDir);

  assert.equal(result.root, rootDir);
  assert.deepEqual(result.executableFiles, DECLARED_BIN_FILES);
  assert.equal(result.ordinaryFiles.length, ORDINARY_PUBLIC_FILES.length);
  for (const relPath of ORDINARY_PUBLIC_FILES) {
    assert.ok(result.ordinaryFiles.includes(relPath), `expected ordinary file ${relPath}`);
    assert.ok(!result.executableFiles.includes(relPath), `unexpected executable file ${relPath}`);
    assert.equal(readActualMode(rootDir, relPath), ORDINARY_FILE_MODE);
  }
  for (const relPath of DECLARED_BIN_FILES) {
    assert.ok(result.executableFiles.includes(relPath), `expected executable file ${relPath}`);
    assert.ok(!result.ordinaryFiles.includes(relPath), `unexpected ordinary file ${relPath}`);
    assert.equal(readActualMode(rootDir, relPath), EXECUTABLE_FILE_MODE);
  }
  assert.equal(
    result.normalizedFiles.length,
    result.ordinaryFiles.length + result.executableFiles.length,
  );
});

test("includes generated.map.js as ordinary runtime JS (0644) rather than a source-map byproduct", (t) => {
  const { rootDir } = createPackageFixture(t);
  const mapNamedModules = ["dist/generated.map.js", "dist/runtime/generated.map.js"];
  for (const relPath of mapNamedModules) {
    writeModeFile(rootDir, relPath, `export const id = ${JSON.stringify(relPath)};\n`, 0o755);
    assert.equal(readActualMode(rootDir, relPath), 0o755);
  }

  const result = normalizePackageModes({ rootDir });

  for (const relPath of mapNamedModules) {
    assert.ok(result.ordinaryFiles.includes(relPath), `${relPath} must be treated as ordinary JS`);
    assert.ok(result.normalizedFiles.includes(relPath), `${relPath} must be included`);
    assert.ok(!result.executableFiles.includes(relPath), `${relPath} must not be executable`);
    assert.equal(readActualMode(rootDir, relPath), ORDINARY_FILE_MODE);
  }
});

test("excludes legitimate paired .d.ts and .js.map files with bytes and modes unchanged", (t) => {
  const { rootDir } = createPackageFixture(t);
  const pairedByproducts = [
    {
      relPath: "dist/index.d.ts",
      mode: 0o600,
      bytes: Buffer.from("export declare const root: true;\n", "utf8"),
    },
    {
      relPath: "dist/index.js.map",
      mode: 0o700,
      bytes: Buffer.from('{"version":3,"file":"index.js"}\n', "utf8"),
    },
    {
      relPath: "dist/cli/index.d.ts",
      mode: 0o640,
      bytes: Buffer.from("export declare function runCli(): void;\n", "utf8"),
    },
    {
      relPath: "dist/cli/index.js.map",
      mode: 0o750,
      bytes: Buffer.from('{"version":3,"file":"cli/index.js"}\n', "utf8"),
    },
  ];

  for (const item of pairedByproducts) {
    writeModeFile(rootDir, item.relPath, item.bytes, item.mode);
    assert.equal(readActualMode(rootDir, item.relPath), item.mode);
  }

  const result = normalizePackageModes(rootDir);

  for (const item of pairedByproducts) {
    assert.ok(!result.normalizedFiles.includes(item.relPath));
    assert.ok(!result.ordinaryFiles.includes(item.relPath));
    assert.ok(!result.executableFiles.includes(item.relPath));
    assert.equal(readActualMode(rootDir, item.relPath), item.mode);
    assert.deepEqual(readFileSync(resolve(rootDir, item.relPath)), item.bytes);
  }
  assert.equal(readActualMode(rootDir, "dist/index.js"), ORDINARY_FILE_MODE);
  assert.equal(readActualMode(rootDir, "dist/cli/index.js"), EXECUTABLE_FILE_MODE);
});

for (const pairedMapSidecar of [
  {
    sidecarName: "generated.map.d.ts",
    sidecarRelPath: "dist/generated.map.d.ts",
    mode: 0o600,
    bytes: Buffer.from("export declare const id: string;\n", "utf8"),
  },
  {
    sidecarName: "generated.map.js.map",
    sidecarRelPath: "dist/generated.map.js.map",
    mode: 0o700,
    bytes: Buffer.from('{"version":3,"file":"generated.map.js"}\n', "utf8"),
  },
]) {
  test(`excludes paired ${pairedMapSidecar.sidecarName} sidecar when companion generated.map.js exists`, (t) => {
    const { rootDir } = createPackageFixture(t);
    const companionRelPath = "dist/generated.map.js";
    const companionBytes = Buffer.from('export const id = "generated.map";\n', "utf8");
    writeModeFile(rootDir, companionRelPath, companionBytes, 0o755);
    writeModeFile(
      rootDir,
      pairedMapSidecar.sidecarRelPath,
      pairedMapSidecar.bytes,
      pairedMapSidecar.mode,
    );
    assert.equal(readActualMode(rootDir, companionRelPath), 0o755);
    assert.equal(readActualMode(rootDir, pairedMapSidecar.sidecarRelPath), pairedMapSidecar.mode);

    const result = normalizePackageModes(rootDir);

    assert.ok(result.ordinaryFiles.includes(companionRelPath));
    assert.ok(result.normalizedFiles.includes(companionRelPath));
    assert.ok(!result.executableFiles.includes(companionRelPath));
    assert.equal(readActualMode(rootDir, companionRelPath), ORDINARY_FILE_MODE);
    assert.deepEqual(readFileSync(resolve(rootDir, companionRelPath)), companionBytes);

    assert.ok(!result.normalizedFiles.includes(pairedMapSidecar.sidecarRelPath));
    assert.ok(!result.ordinaryFiles.includes(pairedMapSidecar.sidecarRelPath));
    assert.ok(!result.executableFiles.includes(pairedMapSidecar.sidecarRelPath));
    assert.equal(readActualMode(rootDir, pairedMapSidecar.sidecarRelPath), pairedMapSidecar.mode);
    assert.deepEqual(
      readFileSync(resolve(rootDir, pairedMapSidecar.sidecarRelPath)),
      pairedMapSidecar.bytes,
    );
  });
}

test("includes index.d.js in dist as ordinary runtime JS (0644)", (t) => {
  const { rootDir } = createPackageFixture(t);
  const relPath = "dist/index.d.js";
  const bytes = Buffer.from("export const d = true;\n", "utf8");
  writeModeFile(rootDir, relPath, bytes, 0o755);
  assert.equal(readActualMode(rootDir, relPath), 0o755);

  const result = normalizePackageModes(rootDir);

  assert.ok(result.ordinaryFiles.includes(relPath), `${relPath} must be treated as ordinary JS`);
  assert.ok(result.normalizedFiles.includes(relPath), `${relPath} must be included`);
  assert.ok(!result.executableFiles.includes(relPath), `${relPath} must not be executable`);
  assert.equal(readActualMode(rootDir, relPath), ORDINARY_FILE_MODE);
  assert.deepEqual(readFileSync(resolve(rootDir, relPath)), bytes);
});

test("is idempotent and preserves exact file bytes across repeated normalizations", (t) => {
  const customContents = {
    "README.md": Buffer.from([
      0x23, 0x20, 0x50, 0x6c, 0x61, 0x79, 0x4f, 0x70, 0x73, 0x00, 0xff, 0x0a,
    ]),
    "dist/index.js": Buffer.from("export const marker = 'exact-bytes-check';\r\n\n", "utf8"),
  };
  const { rootDir } = createPackageFixture(t, { customContents });

  const beforeBytes = new Map(
    ALL_REQUIRED_PUBLIC_FILES.map((relPath) => [
      relPath,
      Buffer.from(readFileSync(resolve(rootDir, relPath))),
    ]),
  );

  const first = normalizePackageModes(rootDir);
  const second = normalizePackageModes({ rootDir });

  assert.deepEqual(second, first);
  for (const relPath of ALL_REQUIRED_PUBLIC_FILES) {
    const expectedMode = DECLARED_BIN_FILES.includes(relPath)
      ? EXECUTABLE_FILE_MODE
      : ORDINARY_FILE_MODE;
    assert.equal(readActualMode(rootDir, relPath), expectedMode);
    assert.deepEqual(readFileSync(resolve(rootDir, relPath)), beforeBytes.get(relPath));
  }
});

test("leaves private and non-allowlisted files outside dist untouched", (t) => {
  const { rootDir } = createPackageFixture(t);
  const privateFiles = [
    { relPath: "src/index.ts", mode: 0o600, bytes: Buffer.from("export {};\n", "utf8") },
    { relPath: "tests/unit.test.ts", mode: 0o750, bytes: Buffer.from("// test\n", "utf8") },
    { relPath: "docs/architecture.md", mode: 0o640, bytes: Buffer.from("# Internal\n", "utf8") },
    { relPath: "config/playops.yaml", mode: 0o600, bytes: Buffer.from("secret: true\n", "utf8") },
    { relPath: "PLAYOPS_PLAN.md", mode: 0o700, bytes: Buffer.from("# Plan\n", "utf8") },
    { relPath: ".env", mode: 0o600, bytes: Buffer.from("TOKEN=secret\n", "utf8") },
  ];

  for (const item of privateFiles) {
    writeModeFile(rootDir, item.relPath, item.bytes, item.mode);
    assert.equal(readActualMode(rootDir, item.relPath), item.mode);
  }

  const result = normalizePackageModes(rootDir);

  for (const item of privateFiles) {
    assert.ok(!result.normalizedFiles.includes(item.relPath));
    assert.equal(readActualMode(rootDir, item.relPath), item.mode);
    assert.deepEqual(readFileSync(resolve(rootDir, item.relPath)), item.bytes);
  }
});

test("preserves process.umask on both success and refusal while enforcing exact modes", (t) => {
  const { rootDir: validRoot } = createPackageFixture(t);
  const { rootDir: invalidRoot } = createPackageFixture(t);
  writeModeFile(invalidRoot, "dist/orphan.d.ts", "export {};\n", 0o600);

  const originalUmask = process.umask(0o077);
  try {
    assert.equal(process.umask(), 0o077);
    normalizePackageModes(validRoot);
    assert.equal(process.umask(), 0o077);
    assert.equal(readActualMode(validRoot, "README.md"), ORDINARY_FILE_MODE);
    assert.equal(readActualMode(validRoot, "dist/cli/index.js"), EXECUTABLE_FILE_MODE);

    assert.throws(() => normalizePackageModes(invalidRoot), /orphan without dist\/orphan\.js/u);
    assert.equal(process.umask(), 0o077);
  } finally {
    process.umask(originalUmask);
  }
});

for (const refusalCase of [
  {
    name: "orphan .d.ts in dist",
    setup: (rootDir) => writeModeFile(rootDir, "dist/orphan.d.ts", "export {};\n", 0o644),
    pattern: /orphan without dist\/orphan\.js/u,
  },
  {
    name: "orphan nested .js.map in dist",
    setup: (rootDir) => writeModeFile(rootDir, "dist/cli/orphan.js.map", "{}\n", 0o644),
    pattern: /orphan without dist\/cli\/orphan\.js/u,
  },
  {
    name: "unpaired declaration sourcemap .d.ts.map in dist",
    setup: (rootDir) => writeModeFile(rootDir, "dist/index.d.ts.map", "{}\n", 0o644),
    pattern: /unexpected non-JS entry in dist: dist\/index\.d\.ts\.map/u,
  },
  {
    name: "foreign JSON credential file in dist",
    setup: (rootDir) => writeModeFile(rootDir, "dist/config/service-account.json", "{}\n", 0o600),
    pattern: /unexpected non-JS entry in dist: dist\/config\/service-account\.json/u,
  },
  {
    name: "foreign TypeScript source file in dist",
    setup: (rootDir) => writeModeFile(rootDir, "dist/cli/index.ts", "export {};\n", 0o644),
    pattern: /unexpected non-JS entry in dist: dist\/cli\/index\.ts/u,
  },
  {
    name: "hidden file in dist",
    setup: (rootDir) => writeModeFile(rootDir, "dist/.hidden.js", "export {};\n", 0o644),
    pattern: /unexpected hidden or invalid entry in dist: dist\/\.hidden\.js/u,
  },
  {
    name: "empty directory in dist",
    setup: (rootDir) => mkdirSync(resolve(rootDir, "dist/empty-subdir"), { recursive: true }),
    pattern: /unexpected empty directory in dist: dist\/empty-subdir/u,
  },
  {
    name: "extra direct file in deploy",
    setup: (rootDir) => writeModeFile(rootDir, "deploy/unapproved.conf", "# unapproved\n", 0o644),
    pattern:
      /unexpected file in deploy: deploy\/unapproved\.conf: is not an approved deployment template/u,
  },
  {
    name: "extra nested file in deploy/systemd",
    setup: (rootDir) =>
      writeModeFile(rootDir, "deploy/systemd/unapproved.conf", "# unapproved\n", 0o644),
    pattern:
      /unexpected file in deploy: deploy\/systemd\/unapproved\.conf: is not an approved deployment template/u,
  },
  {
    name: "extra nested file in deploy/tmpfiles.d",
    setup: (rootDir) =>
      writeModeFile(rootDir, "deploy/tmpfiles.d/unapproved.conf", "# unapproved\n", 0o644),
    pattern:
      /unexpected file in deploy: deploy\/tmpfiles\.d\/unapproved\.conf: is not an approved deployment template/u,
  },
  {
    name: "hidden file in deploy",
    setup: (rootDir) => writeModeFile(rootDir, "deploy/.hidden.conf", "# hidden\n", 0o644),
    pattern: /unexpected hidden or invalid entry in deploy: deploy\/\.hidden\.conf/u,
  },
  {
    name: "hidden nested file in deploy/systemd",
    setup: (rootDir) =>
      writeModeFile(rootDir, "deploy/systemd/.hidden.service", "# hidden\n", 0o644),
    pattern: /unexpected hidden or invalid entry in deploy: deploy\/systemd\/\.hidden\.service/u,
  },
  {
    name: "unexpected directory in deploy",
    setup: (rootDir) => mkdirSync(resolve(rootDir, "deploy/extra-dir"), { recursive: true }),
    pattern: /unexpected directory in deploy: deploy\/extra-dir/u,
  },
  {
    name: "unexpected nested directory in deploy/systemd",
    setup: (rootDir) =>
      mkdirSync(resolve(rootDir, "deploy/systemd/extra-dir"), { recursive: true }),
    pattern: /unexpected directory in deploy: deploy\/systemd\/extra-dir/u,
  },
  {
    name: "missing required deployment template deploy/systemd/playops.service",
    setup: (rootDir) => rmSync(resolve(rootDir, "deploy/systemd/playops.service")),
    pattern: /missing required deployment template: deploy\/systemd\/playops\.service/u,
  },
  {
    name: "missing required deployment template deploy/tmpfiles.d/playops.conf",
    setup: (rootDir) => rmSync(resolve(rootDir, "deploy/tmpfiles.d/playops.conf")),
    pattern: /missing required deployment template: deploy\/tmpfiles\.d\/playops\.conf/u,
  },
]) {
  test(`refuses ${refusalCase.name} without mutating payload modes`, (t) => {
    const { rootDir } = createPackageFixture(t);
    refusalCase.setup(rootDir);

    assert.throws(() => normalizePackageModes(rootDir), refusalCase.pattern);
    assert.equal(readActualMode(rootDir, "README.md"), INITIAL_ORDINARY_MODE);
    assert.equal(readActualMode(rootDir, "dist/cli/index.js"), INITIAL_BIN_MODE);
    assert.equal(readActualMode(rootDir, "dist/daemon/main.js"), INITIAL_BIN_MODE);
    for (const templateRelPath of DEPLOYMENT_TEMPLATE_FILES) {
      let exists;
      try {
        exists = lstatSync(resolve(rootDir, templateRelPath)).isFile();
      } catch {
        exists = false;
      }
      if (exists) {
        assert.equal(readActualMode(rootDir, templateRelPath), INITIAL_ORDINARY_MODE);
      }
    }
  });
}

for (const linkOrTypeCase of [
  {
    name: "symlinked ordinary payload file",
    setup: (rootDir) => {
      const target = writeModeFile(rootDir, "outside-readme.txt", "outside\n", 0o600);
      rmSync(resolve(rootDir, "README.md"));
      symlinkSync(target, resolve(rootDir, "README.md"));
    },
    pattern: /target must not be a symbolic link: README\.md/u,
  },
  {
    name: "symlinked declared bin entrypoint in dist",
    setup: (rootDir) => {
      const target = writeModeFile(rootDir, "outside-bin.js", "export {};\n", 0o600);
      rmSync(resolve(rootDir, "dist/cli/index.js"));
      symlinkSync(target, resolve(rootDir, "dist/cli/index.js"));
    },
    pattern: /symbolic link is not allowed in dist: dist\/cli\/index\.js/u,
  },
  {
    name: "symlinked paired byproduct in dist",
    setup: (rootDir) => {
      const target = writeModeFile(rootDir, "outside.d.ts", "export {};\n", 0o600);
      symlinkSync(target, resolve(rootDir, "dist/index.d.ts"));
    },
    pattern: /symbolic link is not allowed in dist: dist\/index\.d\.ts/u,
  },
  {
    name: "symlinked ancestor directory for public docs",
    setup: (rootDir) => {
      const altDocs = resolve(rootDir, "alt-docs");
      mkdirSync(altDocs, { recursive: true });
      for (const docPath of OPERATOR_DOC_FILES) {
        writeModeFile(rootDir, `alt-${docPath}`, "# doc\n", INITIAL_ORDINARY_MODE);
      }
      rmSync(resolve(rootDir, "docs"), { recursive: true, force: true });
      symlinkSync(altDocs, resolve(rootDir, "docs"));
    },
    pattern: /ancestor directory docs must not be a symbolic link/u,
  },
  {
    name: "symlinked subdirectory inside dist",
    setup: (rootDir) => {
      const altCli = resolve(rootDir, "alt-cli");
      mkdirSync(altCli, { recursive: true });
      writeModeFile(rootDir, "alt-cli/index.js", "export {};\n", INITIAL_BIN_MODE);
      writeModeFile(rootDir, "alt-cli/main.js", "export {};\n", INITIAL_ORDINARY_MODE);
      rmSync(resolve(rootDir, "dist/cli"), { recursive: true, force: true });
      symlinkSync(altCli, resolve(rootDir, "dist/cli"));
    },
    pattern: /symbolic link is not allowed in dist: dist\/cli/u,
  },
  {
    name: "hardlinked ordinary payload file (nlink > 1)",
    setup: (rootDir) => {
      linkSync(resolve(rootDir, "README.md"), resolve(rootDir, "README.hardlink"));
    },
    pattern: /target regular file must have nlink === 1.*README\.md/u,
  },
  {
    name: "hardlinked declared bin entrypoint (nlink > 1)",
    setup: (rootDir) => {
      linkSync(resolve(rootDir, "dist/cli/index.js"), resolve(rootDir, "cli-bin.hardlink"));
    },
    pattern: /target regular file must have nlink === 1.*dist\/cli\/index\.js/u,
  },
  {
    name: "hardlinked paired byproduct in dist (nlink > 1)",
    setup: (rootDir) => {
      const dtsPath = writeModeFile(rootDir, "dist/index.d.ts", "export {};\n", 0o600);
      linkSync(dtsPath, resolve(rootDir, "index-dts.hardlink"));
    },
    pattern: /target regular file must have nlink === 1.*dist\/index\.d\.ts/u,
  },
  {
    name: "directory replacing a regular payload file",
    setup: (rootDir) => {
      rmSync(resolve(rootDir, "README.md"));
      mkdirSync(resolve(rootDir, "README.md"));
    },
    pattern: /target must be a regular file: README\.md/u,
  },
  {
    name: "non-regular special entry in dist via partial fs override",
    setup: (rootDir) => {
      const distPath = resolve(rootDir, "dist");
      const specialFull = resolve(distPath, "fifo.pipe");
      return {
        fs: {
          readdirSync(targetPath) {
            const entries = readdirSync(targetPath);
            return targetPath === distPath ? [...entries, "fifo.pipe"] : entries;
          },
          lstatSync(targetPath) {
            if (targetPath === specialFull) {
              return {
                isSymbolicLink: () => false,
                isDirectory: () => false,
                isFile: () => false,
              };
            }
            return lstatSync(targetPath);
          },
        },
      };
    },
    pattern: /non-regular entry is not allowed in dist: dist\/fifo\.pipe/u,
  },
  {
    name: "symlinked deployment template in deploy",
    setup: (rootDir) => {
      const target = writeModeFile(rootDir, "outside-playops.service", "[Unit]\n", 0o600);
      rmSync(resolve(rootDir, "deploy/systemd/playops.service"));
      symlinkSync(target, resolve(rootDir, "deploy/systemd/playops.service"));
    },
    pattern: /symbolic link is not allowed in deploy: deploy\/systemd\/playops\.service/u,
  },
  {
    name: "symlinked extra file in deploy",
    setup: (rootDir) => {
      const target = writeModeFile(rootDir, "outside-deploy.conf", "# outside\n", 0o600);
      symlinkSync(target, resolve(rootDir, "deploy/unapproved-link.conf"));
    },
    pattern: /symbolic link is not allowed in deploy: deploy\/unapproved-link\.conf/u,
  },
  {
    name: "symlinked deploy root directory",
    setup: (rootDir) => {
      const altDeploy = resolve(rootDir, "alt-deploy");
      mkdirSync(altDeploy, { recursive: true });
      for (const relPath of DEPLOYMENT_TEMPLATE_FILES) {
        writeModeFile(rootDir, `alt-${relPath}`, "# template\n", INITIAL_ORDINARY_MODE);
      }
      rmSync(resolve(rootDir, "deploy"), { recursive: true, force: true });
      symlinkSync(altDeploy, resolve(rootDir, "deploy"));
    },
    pattern: /deploy directory must not be a symbolic link/u,
  },
  {
    name: "symlinked subdirectory inside deploy",
    setup: (rootDir) => {
      const altSystemd = resolve(rootDir, "alt-systemd");
      mkdirSync(altSystemd, { recursive: true });
      writeModeFile(rootDir, "alt-systemd/playops.service", "[Unit]\n", INITIAL_ORDINARY_MODE);
      rmSync(resolve(rootDir, "deploy/systemd"), { recursive: true, force: true });
      symlinkSync(altSystemd, resolve(rootDir, "deploy/systemd"));
    },
    pattern: /symbolic link is not allowed in deploy: deploy\/systemd/u,
  },
  {
    name: "hardlinked deployment template in deploy (nlink > 1)",
    setup: (rootDir) => {
      linkSync(
        resolve(rootDir, "deploy/systemd/playops.service"),
        resolve(rootDir, "playops-service.hardlink"),
      );
    },
    pattern: /target regular file must have nlink === 1.*deploy\/systemd\/playops\.service/u,
  },
  {
    name: "directory replacing a required deployment template in deploy",
    setup: (rootDir) => {
      rmSync(resolve(rootDir, "deploy/systemd/playops.service"));
      mkdirSync(resolve(rootDir, "deploy/systemd/playops.service"));
    },
    pattern: /unexpected directory in deploy: deploy\/systemd\/playops\.service/u,
  },
  {
    name: "regular file replacing an approved deployment subdirectory",
    setup: (rootDir) => {
      rmSync(resolve(rootDir, "deploy/systemd"), { recursive: true, force: true });
      writeModeFile(rootDir, "deploy/systemd", "# not a dir\n", INITIAL_ORDINARY_MODE);
    },
    pattern: /unexpected file in deploy: deploy\/systemd: is not an approved deployment template/u,
  },
  {
    name: "non-regular special entry in deploy via partial fs override",
    setup: (rootDir) => {
      const deployPath = resolve(rootDir, "deploy");
      const specialFull = resolve(deployPath, "fifo.pipe");
      return {
        fs: {
          readdirSync(targetPath) {
            const entries = readdirSync(targetPath);
            return targetPath === deployPath ? [...entries, "fifo.pipe"] : entries;
          },
          lstatSync(targetPath) {
            if (targetPath === specialFull) {
              return {
                isSymbolicLink: () => false,
                isDirectory: () => false,
                isFile: () => false,
              };
            }
            return lstatSync(targetPath);
          },
        },
      };
    },
    pattern: /non-regular entry is not allowed in deploy: deploy\/fifo\.pipe/u,
  },
  {
    name: "unsafe entry name in deploy via partial fs override",
    setup: (rootDir) => {
      const deployPath = resolve(rootDir, "deploy");
      return {
        fs: {
          readdirSync(targetPath) {
            const entries = readdirSync(targetPath);
            return targetPath === deployPath ? [...entries, "bad\\entry.conf"] : entries;
          },
        },
      };
    },
    pattern: /unsafe relative path/u,
  },
]) {
  test(`refuses ${linkOrTypeCase.name}`, (t) => {
    const { rootDir } = createPackageFixture(t);
    const extraOptions = linkOrTypeCase.setup(rootDir) ?? {};

    assert.throws(
      () => normalizePackageModes({ rootDir, ...extraOptions }),
      linkOrTypeCase.pattern,
    );
    assert.equal(readActualMode(rootDir, "LICENSE"), INITIAL_ORDINARY_MODE);
    assert.equal(readActualMode(rootDir, "dist/daemon/main.js"), INITIAL_BIN_MODE);
    let tmpfilesExists;
    try {
      tmpfilesExists =
        !lstatSync(resolve(rootDir, "deploy")).isSymbolicLink() &&
        lstatSync(resolve(rootDir, "deploy/tmpfiles.d/playops.conf")).isFile();
    } catch {
      tmpfilesExists = false;
    }
    if (tmpfilesExists) {
      assert.equal(
        readActualMode(rootDir, "deploy/tmpfiles.d/playops.conf"),
        INITIAL_ORDINARY_MODE,
      );
    }
  });
}

for (const unsafePath of [
  "",
  ".",
  "..",
  "../outside.js",
  "dist/../outside.js",
  "./dist/index.js",
  "/etc/passwd",
  "C:/Windows/win.ini",
  "dist\\index.js",
  "dist//index.js",
  "dist/bad\0file.js",
  "dist/bad\nfile.js",
]) {
  test(`assertSafeRelativePath rejects ${JSON.stringify(unsafePath)}`, () => {
    assert.throws(() => assertSafeRelativePath(unsafePath), /unsafe relative path/u);
  });
}

test("enforces root boundary, path-escape, option, and metadata contract guards", (t) => {
  const { rootDir } = createPackageFixture(t);

  assert.equal(assertSafeRelativePath("dist/cli/index.js"), "dist/cli/index.js");

  const symlinkRoot = join(
    dirname(rootDir),
    `symlink-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  symlinkSync(rootDir, symlinkRoot);
  t.after(() => {
    rmSync(symlinkRoot, { force: true });
  });

  for (const invalidCall of [
    { fn: () => normalizePackageModes("relative/root"), pattern: /clean absolute path/u },
    { fn: () => normalizePackageModes(`${rootDir}/..`), pattern: /canonical non-root/u },
    { fn: () => normalizePackageModes("/"), pattern: /canonical non-root/u },
    {
      fn: () => normalizePackageModes(symlinkRoot),
      pattern: /package root must not be a symbolic link/u,
    },
    {
      fn: () => normalizePackageModes(rootDir, ["README.md"]),
      pattern: /caller-controlled target lists and extra arguments are not accepted/u,
    },
    {
      fn: () => normalizePackageModes({ rootDir, targets: ["README.md"] }),
      pattern: /unsupported normalizer option/u,
    },
    {
      fn: () =>
        normalizePackageModes({
          rootDir,
          fs: {
            realpathSync(targetPath) {
              if (targetPath === resolve(rootDir, "README.md")) {
                return resolve(rootDir, "..", "escaped-readme.md");
              }
              return realpathSync(targetPath);
            },
          },
        }),
      pattern: /target path must not traverse symbolic links: README\.md/u,
    },
  ]) {
    assert.throws(invalidCall.fn, invalidCall.pattern);
  }

  const { rootDir: escapedBinRoot } = createPackageFixture(t, {
    metadataOverrides: {
      bin: { playops: "../escape.js", playopsd: "dist/daemon/main.js" },
    },
  });
  assert.throws(() => normalizePackageModes(escapedBinRoot), /unsafe relative path/u);

  const { rootDir: missingModuleRoot } = createPackageFixture(t, {
    omitFiles: ["dist/approvals/challenge.js"],
  });
  assert.throws(
    () => normalizePackageModes(missingModuleRoot),
    /missing required compiled module: dist\/approvals\/challenge\.js/u,
  );

  for (const requiredTemplate of DEPLOYMENT_TEMPLATE_FILES) {
    const { rootDir: missingTemplateRoot } = createPackageFixture(t, {
      omitFiles: [requiredTemplate],
    });
    const remainingTemplate = DEPLOYMENT_TEMPLATE_FILES.find(
      (candidate) => candidate !== requiredTemplate,
    );
    assert.throws(
      () => normalizePackageModes(missingTemplateRoot),
      new RegExp(
        `missing required deployment template: ${requiredTemplate.replaceAll(".", "\\.")}`,
        "u",
      ),
    );
    assert.equal(readActualMode(missingTemplateRoot, "README.md"), INITIAL_ORDINARY_MODE);
    assert.equal(readActualMode(missingTemplateRoot, "dist/cli/index.js"), INITIAL_BIN_MODE);
    if (remainingTemplate !== undefined) {
      assert.equal(readActualMode(missingTemplateRoot, remainingTemplate), INITIAL_ORDINARY_MODE);
    }
  }
});

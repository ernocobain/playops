import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPROVED_PACKAGE_FIELDS,
  DEPLOYMENT_TEMPLATE_FILES,
  OPERATOR_DOC_FILES,
  REQUIRED_MODULE_FILES,
  ROOT_PAYLOAD_FILES,
  RUNTIME_DEPENDENCIES,
} from "./package-content.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cleaner = join(root, "scripts", "clean-dist.mjs");
const normalizer = join(root, "scripts", "normalize-package-modes.mjs");
const packageContent = join(root, "scripts", "package-content.mjs");
const npmCli = resolve(
  dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

function fixture() {
  const base = realpathSync(
    mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-clean-dist-")),
  );
  const repo = join(base, "repository with spaces");
  const unrelated = join(base, "unrelated");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "src", "daemon"), { recursive: true });
  mkdirSync(join(unrelated, "dist"), { recursive: true });
  writeFileSync(join(unrelated, "dist", "keep.txt"), "outside build output");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      ...APPROVED_PACKAGE_FIELDS,
      version: "0.4.0",
      dependencies: { ...RUNTIME_DEPENDENCIES },
      scripts: { build: metadata.scripts.build, prepack: metadata.scripts.prepack },
    }),
  );
  for (const relPath of [
    ...ROOT_PAYLOAD_FILES,
    ...OPERATOR_DOC_FILES,
    ...DEPLOYMENT_TEMPLATE_FILES,
  ]) {
    if (relPath === "package.json") continue;
    const targetPath = join(repo, relPath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `# synthetic ${relPath}\n`);
  }
  writeFileSync(
    join(repo, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        outDir: "dist",
        rootDir: "src",
        module: "NodeNext",
        target: "ES2022",
        declaration: true,
        sourceMap: true,
        types: [],
        skipLibCheck: true,
      },
      include: ["src/**/*.ts"],
    }),
  );
  for (const modulePath of REQUIRED_MODULE_FILES) {
    const sourcePath = join(repo, modulePath.replace(/^dist\//u, "src/").replace(/\.js$/u, ".ts"));
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export {};\n");
  }
  writeFileSync(
    join(repo, "src", "daemon", "package-operation-singleflight.ts"),
    "export const currentCoordinator = true;\n",
  );
  if (existsSync(cleaner)) cpSync(cleaner, join(repo, "scripts", "clean-dist.mjs"));
  if (existsSync(normalizer))
    cpSync(normalizer, join(repo, "scripts", "normalize-package-modes.mjs"));
  if (existsSync(packageContent))
    cpSync(packageContent, join(repo, "scripts", "package-content.mjs"));
  return { base, repo, unrelated };
}

function run(f, args = [], cwd = f.unrelated) {
  return spawnSync(process.execPath, [join(f.repo, "scripts", "clean-dist.mjs"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? "", TMPDIR: f.base, NODE_ENV: "development" },
  });
}

function seed(f) {
  mkdirSync(join(f.repo, "dist", "daemon"), { recursive: true });
  for (const suffix of ["js", "d.ts", "js.map"]) {
    writeFileSync(
      join(f.repo, "dist", "daemon", `commit-singleflight.${suffix}`),
      "obsolete output\n",
    );
  }
}

function assertOutsidePreserved(f) {
  assert.equal(readFileSync(join(f.unrelated, "dist", "keep.txt"), "utf8"), "outside build output");
  assert.equal(
    readFileSync(join(f.repo, "src", "daemon", "package-operation-singleflight.ts"), "utf8"),
    "export const currentCoordinator = true;\n",
  );
  assert.ok(existsSync(join(f.repo, "package.json")));
  assert.ok(existsSync(join(f.repo, "tsconfig.json")));
}

test("ordinary build and npm prepack remove obsolete outputs and emit only the current module", () => {
  const f = fixture();
  try {
    symlinkSync(join(root, "node_modules"), join(f.repo, "node_modules"), "dir");
    seed(f);
    const built = spawnSync(process.execPath, [npmCli, "run", "build"], {
      cwd: f.repo,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", TMPDIR: f.base, NODE_ENV: "development" },
    });
    assert.equal(built.status, 0, built.stderr);
    for (const suffix of ["js", "d.ts", "js.map"]) {
      assert.equal(
        existsSync(join(f.repo, "dist", "daemon", `commit-singleflight.${suffix}`)),
        false,
        `obsolete ${suffix} survived ordinary build`,
      );
      assert.ok(
        existsSync(join(f.repo, "dist", "daemon", `package-operation-singleflight.${suffix}`)),
      );
    }
    seed(f);
    const packed = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
      cwd: f.repo,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", TMPDIR: f.base, NODE_ENV: "development" },
    });
    assert.equal(packed.status, 0, packed.stderr);
    const manifest = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0];
    const paths = manifest.files.map((entry) => entry.path);
    assert.ok(paths.includes("dist/daemon/package-operation-singleflight.js"));
    assert.equal(
      paths.some((path) => path.includes("commit-singleflight")),
      false,
    );
    assertOutsidePreserved(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("ordinary npm pack lifecycle produces a real archive for valid deploy inventory and refuses extra direct or nested deploy files with no tarball output", () => {
  const validFixture = fixture();
  try {
    symlinkSync(join(root, "node_modules"), join(validFixture.repo, "node_modules"), "dir");
    const packDir = join(validFixture.base, "pack-out");
    mkdirSync(packDir, { recursive: true });
    const packed = spawnSync(
      process.execPath,
      [npmCli, "pack", "--json", "--pack-destination", packDir],
      {
        cwd: validFixture.repo,
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: process.env.PATH ?? "", TMPDIR: validFixture.base, NODE_ENV: "development" },
      },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const manifest = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0];
    const tarballPath = join(packDir, manifest.filename);
    assert.ok(existsSync(tarballPath), "expected real tarball archive on disk");
    assert.ok(statSync(tarballPath).size > 0);
    const deployPaths = manifest.files
      .map((entry) => entry.path)
      .filter((path) => path.startsWith("deploy/"))
      .sort();
    assert.deepEqual(deployPaths, [...DEPLOYMENT_TEMPLATE_FILES].sort());
    assertOutsidePreserved(validFixture);
  } finally {
    rmSync(validFixture.base, { recursive: true, force: true });
  }

  for (const unapprovedRelPath of ["deploy/unapproved.conf", "deploy/systemd/unapproved.conf"]) {
    const invalidFixture = fixture();
    try {
      symlinkSync(join(root, "node_modules"), join(invalidFixture.repo, "node_modules"), "dir");
      const packDir = join(invalidFixture.base, "pack-out");
      mkdirSync(packDir, { recursive: true });
      const unapprovedFullPath = join(invalidFixture.repo, unapprovedRelPath);
      mkdirSync(dirname(unapprovedFullPath), { recursive: true });
      writeFileSync(unapprovedFullPath, "# unapproved deployment entry\n");

      const refused = spawnSync(
        process.execPath,
        [npmCli, "pack", "--json", "--pack-destination", packDir],
        {
          cwd: invalidFixture.repo,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            PATH: process.env.PATH ?? "",
            TMPDIR: invalidFixture.base,
            NODE_ENV: "development",
          },
        },
      );
      assert.notEqual(refused.status, 0, `expected npm pack to refuse ${unapprovedRelPath}`);
      assert.match(
        `${refused.stdout}\n${refused.stderr}`,
        new RegExp(
          `Refusing package mode normalization:.*unexpected file in deploy: ${unapprovedRelPath.replaceAll(".", "\\.")}`,
          "su",
        ),
      );
      assert.deepEqual(
        readdirSync(packDir).filter((name) => name.endsWith(".tgz")),
        [],
      );
      assert.deepEqual(
        readdirSync(invalidFixture.repo).filter((name) => name.endsWith(".tgz")),
        [],
      );
      assertOutsidePreserved(invalidFixture);
    } finally {
      rmSync(invalidFixture.base, { recursive: true, force: true });
    }
  }
});

test("cleanup resolves its own repository, not cwd, and preserves sibling output", () => {
  const f = fixture();
  try {
    seed(f);
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.repo, "dist")), false);
    assertOutsidePreserved(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("missing dist is an idempotent no-op", () => {
  const f = fixture();
  try {
    assert.equal(run(f).status, 0);
    assert.equal(run(f).status, 0);
    assertOutsidePreserved(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("nested symlinks never cause outside data to be followed or removed", () => {
  const f = fixture();
  try {
    seed(f);
    symlinkSync(f.unrelated, join(f.repo, "dist", "outside"), "dir");
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.repo, "dist")), false);
    assertOutsidePreserved(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("refuses dist itself being a symlink and preserves its target", () => {
  const f = fixture();
  try {
    symlinkSync(join(f.unrelated, "dist"), join(f.repo, "dist"), "dir");
    const result = run(f);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing dist cleanup/u);
    assert.ok(lstatSync(join(f.repo, "dist")).isSymbolicLink());
    assertOutsidePreserved(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("refuses an ordinary file named dist instead of deleting it", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "dist"), "not derived directory output");
    const result = run(f);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing dist cleanup/u);
    assert.equal(readFileSync(join(f.repo, "dist"), "utf8"), "not derived directory output");
    assertOutsidePreserved(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

for (const outDir of ["", "/", ".", "../unrelated", "custom-output"]) {
  test(`refuses a non-dist or unsafe configured build output ${JSON.stringify(outDir)}`, () => {
    const f = fixture();
    try {
      seed(f);
      writeFileSync(join(f.repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir } }));
      const result = run(f);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Refusing dist cleanup/u);
      assert.ok(existsSync(join(f.repo, "dist", "daemon", "commit-singleflight.js")));
      assert.equal(
        readFileSync(join(f.unrelated, "dist", "keep.txt"), "utf8"),
        "outside build output",
      );
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });
}

test("refuses a script transplanted into a different package", () => {
  const f = fixture();
  try {
    seed(f);
    writeFileSync(join(f.repo, "package.json"), JSON.stringify({ name: "not-playops" }));
    const result = run(f);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing dist cleanup/u);
    assert.ok(existsSync(join(f.repo, "dist", "daemon", "commit-singleflight.js")));
    assertOutsidePreserved(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("rejects arguments rather than allowing an arbitrary deletion target", () => {
  const f = fixture();
  try {
    seed(f);
    const result = run(f, [f.unrelated]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing dist cleanup/u);
    assert.ok(existsSync(join(f.repo, "dist", "daemon", "commit-singleflight.js")));
    assertOutsidePreserved(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

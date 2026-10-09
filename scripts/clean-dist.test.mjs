import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cleaner = join(root, "scripts", "clean-dist.mjs");
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
  const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-clean-dist-"));
  const repo = join(base, "repository with spaces");
  const unrelated = join(base, "unrelated");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "src", "daemon"), { recursive: true });
  mkdirSync(join(unrelated, "dist"), { recursive: true });
  writeFileSync(join(unrelated, "dist", "keep.txt"), "outside build output");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "playops",
      version: "0.2.0",
      private: true,
      type: "module",
      scripts: { build: metadata.scripts.build, prepack: metadata.scripts.prepack },
      files: ["dist/**/*.js"],
    }),
  );
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
  writeFileSync(
    join(repo, "src", "daemon", "package-operation-singleflight.ts"),
    "export const currentCoordinator = true;\n",
  );
  if (existsSync(cleaner)) cpSync(cleaner, join(repo, "scripts", "clean-dist.mjs"));
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

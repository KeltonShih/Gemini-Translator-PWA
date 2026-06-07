import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.app.json")], {
  cwd: root,
  stdio: "inherit"
});

copyDir(join(root, "public"), dist);
copyFile(join(root, "src/styles.css"), join(dist, "src/styles.css"));

const index = readFileSync(join(root, "index.html"), "utf8")
  .replace('/src/main.ts', '/src/main.js');
writeFileSync(join(dist, "index.html"), index, "utf8");
rewriteJsImports(join(dist, "src"));

function copyDir(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (statSync(source).isDirectory()) copyDir(source, target);
    else copyFile(source, target);
  }
}

function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function rewriteJsImports(directory) {
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) {
      rewriteJsImports(file);
      continue;
    }
    if (!file.endsWith(".js")) continue;
    const next = readFileSync(file, "utf8")
      .replace(/from "(\.\.?\/[^".][^"]*)"/g, 'from "$1.js"')
      .replace(/import\("(\.\.?\/[^".][^"]*)"\)/g, 'import("$1.js")');
    writeFileSync(file, next, "utf8");
  }
}

import { packager } from "@electron/packager";
import { mkdir, cp, access, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
const root = fileURLToPath(new URL("../", import.meta.url));
const [built] = await packager({
  dir: root,
  name: "Watch & Wonder",
  executableName: "Watch & Wonder",
  icon: path.join(root, "assets", "WatchAndWonder.icns"),
  appBundleId: "com.watchandwonder.desktop",
  appCategoryType: "public.app-category.education",
  platform: "darwin",
  arch: process.arch,
  out: path.join(root, "release"),
  overwrite: true,
  asar: false,
  prune: true,
  ignore: [
    /^\/(?:\.local|\.git|tmp|output|models|release|test|docs)(?:\/|$)/,
    /^\/\.env(?:\.|$)/,
  ],
});
const bundle = path.join(built, "Watch & Wonder.app");
const model = path.join(root, "models", "ggml-base.en.bin");
try {
  await access(model);
  await mkdir(path.join(bundle, "Contents/Resources/models"), {
    recursive: true,
  });
  await cp(
    model,
    path.join(bundle, "Contents/Resources/models/ggml-base.en.bin"),
  );
} catch {
  console.warn(
    "Whisper model not bundled. Set WHISPER_MODEL_PATH or run setup before building.",
  );
}
execFileSync(
  "/usr/bin/codesign",
  ["--force", "--deep", "--sign", "-", bundle],
  { stdio: "inherit" },
);
console.log(`Built ${bundle}`);
if (process.argv.includes("--install")) {
  const target = path.join(os.homedir(), "Applications", "Watch & Wonder.app");
  await mkdir(path.dirname(target), { recursive: true });
  // Never replace an existing installation implicitly.
  try {
    await access(target);
    throw new Error(
      `An app already exists at ${target}. Move it aside before installing this build.`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(bundle, target, { recursive: true, verbatimSymlinks: true });
  const shortcut = path.join(os.homedir(), "Desktop", "Watch & Wonder.app");
  try {
    await access(shortcut);
  } catch {
    await symlink(target, shortcut);
  }
  console.log(`Installed ${target}`);
}

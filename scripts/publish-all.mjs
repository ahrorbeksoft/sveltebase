import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { getRootDir, getWorkspacePackages, sortWorkspacePackages, readJson } from "./workspace-tools.mjs";
import { join } from "node:path";

async function main() {
  console.log("=== Sveltebase Release & Publish Tool ===");

  // 1. Check NPM Auth
  console.log("\nChecking npm login status...");
  const whoami = spawnSync("npm", ["whoami"], { stdio: "pipe", encoding: "utf8" });
  if (whoami.status !== 0) {
    console.log("⚠️ NPM login expired or not found. Launching npm login...");
    const login = spawnSync("npm", ["login"], { stdio: "inherit" });
    if (login.status !== 0) {
      console.error("❌ npm login failed. Exiting.");
      process.exit(1);
    }
  } else {
    console.log(`\u001b[32m✅ Logged in as: ${whoami.stdout.trim()}\u001b[0m`);
  }

  // 2. Select version bump type
  const rootDir = getRootDir();
  const rootManifestPath = join(rootDir, "package.json");
  const rootManifest = readJson(rootManifestPath);
  const currentVersion = rootManifest.version;
  console.log(`Current version: ${currentVersion}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const target = await new Promise((resolve) => {
    rl.question(
      "\nSelect version increment (patch, minor, major, or explicit version e.g. 1.0.2): ",
      (answer) => {
        rl.close();
        resolve(answer.trim());
      }
    );
  });

  if (!target) {
    console.error("❌ No version increment specified. Exiting.");
    process.exit(1);
  }

  // 3. Apply versioning
  console.log(`\n> Applying version bump: ${target}...`);
  try {
    const versionResult = spawnSync("bun", ["run", "./scripts/version.mjs", target], { stdio: "inherit" });
    if (versionResult.status !== 0) {
      console.error("❌ Version bump failed.");
      process.exit(versionResult.status ?? 1);
    }
  } catch (err) {
    console.error("❌ Failed to run version.mjs:", err);
    process.exit(1);
  }

  // 4. Run Build
  console.log("\n> Building all workspace packages...");
  const buildResult = spawnSync("bun", ["run", "build"], { stdio: "inherit" });
  if (buildResult.status !== 0) {
    console.error("❌ Build failed. Please fix compilation issues before publishing.");
    process.exit(buildResult.status ?? 1);
  }

  // 5. Publish all packages
  console.log("\n> Publishing packages to npm...");
  const workspacePackages = sortWorkspacePackages(getWorkspacePackages());
  for (const pkg of workspacePackages) {
    if (pkg.manifest.private) {
      continue;
    }

    console.log(`\n> Publishing ${pkg.manifest.name}...`);
    const publishResult = spawnSync("npm", ["publish"], { cwd: pkg.dir, stdio: "inherit" });
    if (publishResult.status !== 0) {
      console.error(`❌ Failed to publish ${pkg.manifest.name}.`);
      process.exit(publishResult.status ?? 1);
    }
  }

  console.log("\n\u001b[32m🎉 All packages built and published successfully!\u001b[0m");
}

main().catch((err) => {
  console.error("Unhandled error in publish-all script:", err);
  process.exit(1);
});

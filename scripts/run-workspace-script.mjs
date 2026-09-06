import { getWorkspacePackages, sortWorkspacePackages, runCommand } from "./workspace-tools.mjs";

const [scriptName] = process.argv.slice(2);

if (!scriptName) {
  console.error("Usage: bun run ./scripts/run-workspace-script.mjs <script-name>");
  process.exit(1);
}

const orderedPackages = sortWorkspacePackages(getWorkspacePackages());
const packages = scriptName === "clean" ? [...orderedPackages].reverse() : orderedPackages;

for (const pkg of packages) {
  if (!pkg.manifest.scripts?.[scriptName]) {
    continue;
  }

  console.log(`\n> ${pkg.manifest.name}: ${scriptName}`);
  runCommand("bun", ["run", scriptName], pkg.dir);
}

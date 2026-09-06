import { getWorkspacePackages, sortWorkspacePackages, runCommand } from "./workspace-tools.mjs";

const passthroughArgs = process.argv.slice(2);
const workspacePackages = sortWorkspacePackages(getWorkspacePackages());

for (const pkg of workspacePackages) {
  if (pkg.manifest.private) {
    continue;
  }

  console.log(`\n> publishing ${pkg.manifest.name}`);
  runCommand("npm", ["publish", ...passthroughArgs], pkg.dir);
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(version, label) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid ${label}: ${version}`);
  }
  const components = version.split('.').map(Number);
  if (!components.every(Number.isSafeInteger)) {
    throw new Error(`Invalid ${label}: ${version}`);
  }
  return components;
}

function formatVersion(components) {
  if (!components.every(Number.isSafeInteger)) {
    throw new Error(
      'Version increment exceeds JavaScript safe integer limits.',
    );
  }
  return components.join('.');
}

export function resolveNextVersion(currentVersion, input) {
  const [major, minor, patch] = parseVersion(currentVersion, 'current version');
  if (VERSION_PATTERN.test(input)) {
    parseVersion(input, 'version target');
    return input;
  }
  switch (input) {
    case 'patch':
      return formatVersion([major, minor, patch + 1]);
    case 'minor':
      return formatVersion([major, minor + 1, 0]);
    case 'major':
      return formatVersion([major + 1, 0, 0]);
    default:
      throw new Error(
        `Unsupported version target: ${input}. Use patch, minor, major, or x.y.z.`,
      );
  }
}

export function getPackageExportPaths(manifest) {
  if (!manifest.name) throw new Error('Package manifest is missing a name.');
  if (!manifest.exports) return [manifest.name];
  if (typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)) {
    throw new Error(`${manifest.name} has an unsupported exports field.`);
  }
  return Object.keys(manifest.exports)
    .filter((exportPath) => exportPath === '.' || exportPath.startsWith('./'))
    .sort()
    .map((exportPath) =>
      exportPath === '.'
        ? manifest.name
        : `${manifest.name}/${exportPath.slice(2)}`,
    );
}

export function parsePublishArguments(argv) {
  let resume = false;
  const npmArguments = [];
  for (const argument of argv) {
    if (argument === '--resume') {
      resume = true;
      continue;
    }
    if (argument === '--help' || argument === '-h')
      return { help: true, resume: false, npmArguments: [] };
    npmArguments.push(argument);
  }
  return { help: false, resume, npmArguments };
}

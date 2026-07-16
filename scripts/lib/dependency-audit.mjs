export const allowedDependencyAdvisory = Object.freeze({
  id: 1103747,
  ghsa: 'GHSA-3gc7-fjrx-p6mg',
  module: 'bigint-buffer',
  version: '1.1.5',
  severity: 'high',
  vulnerableVersions: '<=1.1.5',
});

const blockingSeverities = new Set(['high', 'critical']);

export function collectProductionPackageVersions(projects) {
  if (!Array.isArray(projects)) throw new TypeError('pnpm list output must be an array.');
  const versionsByPackage = new Map();

  const visitDependencies = (dependencies) => {
    if (dependencies === undefined) return;
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new TypeError('pnpm dependency collection must be an object.');
    }

    for (const [dependencyName, dependency] of Object.entries(dependencies)) {
      if (dependency === null || typeof dependency !== 'object' || Array.isArray(dependency)) {
        throw new TypeError(`pnpm dependency ${dependencyName} has an invalid shape.`);
      }
      const version = dependency.version;
      if (
        !dependencyName.startsWith('@opentab/') &&
        typeof version === 'string' &&
        version.length > 0 &&
        !version.startsWith('link:') &&
        !version.startsWith('workspace:')
      ) {
        const versions = versionsByPackage.get(dependencyName) ?? new Set();
        versions.add(version);
        versionsByPackage.set(dependencyName, versions);
      }
      visitDependencies(dependency.dependencies);
      visitDependencies(dependency.optionalDependencies);
    }
  };

  for (const project of projects) {
    if (project === null || typeof project !== 'object' || Array.isArray(project)) {
      throw new TypeError('pnpm project entry has an invalid shape.');
    }
    visitDependencies(project.dependencies);
    visitDependencies(project.optionalDependencies);
  }

  return Object.fromEntries(
    [...versionsByPackage.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
}

export function verifyBulkAdvisoryReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new TypeError('the bulk advisory report root is not an object.');
  }

  const blocking = [];
  for (const [moduleName, advisories] of Object.entries(report)) {
    if (!Array.isArray(advisories)) {
      throw new TypeError(`the bulk advisory list for ${moduleName} is not an array.`);
    }
    for (const advisory of advisories) {
      if (advisory === null || typeof advisory !== 'object' || Array.isArray(advisory)) {
        throw new TypeError(`the bulk advisory entry for ${moduleName} is invalid.`);
      }
      const severity = String(advisory.severity ?? '').toLowerCase();
      if (blockingSeverities.has(severity)) blocking.push({ moduleName, advisory });
    }
  }

  if (blocking.length === 0) return { allowedCount: 0, blockingCount: 0 };
  if (blocking.length !== 1) {
    throw new Error('the report contains more than one high or critical advisory.');
  }

  const candidate = blocking[0];
  const advisory = candidate.advisory;
  if (
    candidate.moduleName !== allowedDependencyAdvisory.module ||
    advisory.id !== allowedDependencyAdvisory.id ||
    advisory.url !== `https://github.com/advisories/${allowedDependencyAdvisory.ghsa}` ||
    advisory.severity !== allowedDependencyAdvisory.severity ||
    advisory.vulnerable_versions !== allowedDependencyAdvisory.vulnerableVersions
  ) {
    throw new Error('the report contains an unapproved or drifted high/critical advisory.');
  }

  return { allowedCount: 1, blockingCount: 1 };
}

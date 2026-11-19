import { existsSync, readFileSync } from 'node:fs';

const runtimeFields = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

for (const name of ['facts-ledger', 'vault']) {
  const manifest = new URL(`../packages/${name}/package.json`, import.meta.url);
  if (name === 'vault' && !existsSync(manifest)) continue;

  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const field of runtimeFields) {
    const value = pkg[field];
    if (value === true || Object.keys(value ?? {}).length > 0) {
      console.error(`${name}: runtime dependencies are forbidden (${field}).`);
      process.exitCode = 1;
    }
  }

  if (name === 'facts-ledger' && pkg.engines?.node !== process.versions.node) {
    console.error('facts-ledger: run checks with the pinned Node version.');
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log('Runtime dependency check passed.');

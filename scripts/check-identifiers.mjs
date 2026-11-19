import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const patterns = [
  ['email address', /[\w.+-]+@[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}\b/i],
  ['home path', /(?:^|[^\w])(?:[a-z]:)?[\\/](?:home|users|documents and settings)[\\/][^\\/\s]+/i],
  ['user profile path', /(?:^|[\s`"'(])~[\\/][^\\/\s]+/],
  ['private IPv4 address', /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2}\b/],
  ['local hostname', /\b[a-z\d][a-z\d-]*\.(?:local|lan|internal|home\.arpa)\b/i],
];

function scanText(text, location) {
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) {
      console.error(`Identifier scan: ${label} in ${location}.`);
      process.exitCode = 1;
    }
  }
}

function scanDirectory(root, relative = '') {
  for (const name of readdirSync(join(root, relative))) {
    const path = join(relative, name);
    const entry = lstatSync(join(root, path));
    scanText(path, 'a file or directory name');
    if (entry.isDirectory()) {
      scanDirectory(root, path);
    } else if (entry.isFile()) {
      const contents = readFileSync(join(root, path), 'utf8');
      for (const [index, line] of contents.split(/\r?\n/).entries()) {
        scanText(line, `file line ${index + 1}`);
      }
    } else {
      console.error('Identifier scan: expected a regular file or directory.');
      process.exitCode = 1;
    }
  }
}

const [archiveContents] = process.argv.slice(2);
const snapshot = archiveContents ? undefined : mkdtempSync(join(tmpdir(), 'foundry-scan-'));
try {
  if (snapshot) {
    execFileSync('git', ['checkout-index', '--all', '--force', `--prefix=${snapshot}/`]);
  }
  const root = snapshot ?? resolve(archiveContents);
  scanDirectory(root);

  // Suppress scanner output so findings in file names or content cannot enter CI logs.
  const result = spawnSync('gitleaks', ['dir', '--redact=100', root], { stdio: 'ignore' });
  if (result.status !== 0) {
    console.error('Identifier scan: Gitleaks reported a finding or could not complete.');
    process.exitCode = 1;
  }
  if (!process.exitCode) console.log('Identifier scan passed (generic identifiers and Gitleaks).');
} finally {
  if (snapshot) rmSync(snapshot, { recursive: true, force: true });
}

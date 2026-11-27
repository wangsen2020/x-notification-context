import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  throw new Error(`Version mismatch: package.json=${pkg.version}, manifest.json=${manifest.version}`);
}

const distDir = path.join(rootDir, 'dist');
const stageDir = path.join(distDir, 'stage');
const zipPath = path.join(distDir, `${pkg.name}-v${pkg.version}.zip`);

fs.rmSync(stageDir, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(stageDir, { recursive: true });

const requiredFiles = [
  'manifest.json',
  'LICENSE',
  ...Object.values(manifest.icons || {}),
  manifest.background?.service_worker,
  'src/parser.js',
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])])
].filter(Boolean);

const uniqueFiles = [...new Set(requiredFiles)];
for (const rel of uniqueFiles) {
  const srcPath = path.join(rootDir, rel);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Missing required extension file: ${rel}`);
  }
  const destPath = path.join(stageDir, rel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
}

if (process.platform === 'win32') {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force`
    ],
    { stdio: 'inherit' }
  );
} else {
  execFileSync('zip', ['-r', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });
}

fs.rmSync(stageDir, { recursive: true, force: true });

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
console.log(`Packed: ${zipPath}`);
console.log(`SHA-256: ${sha256}`);
console.log('Included files:', uniqueFiles.join(', '));

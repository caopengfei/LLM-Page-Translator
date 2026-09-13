import { readFileSync, accessSync, constants } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const files = new Set();

function requireFile(relativePath) {
  const absolute = resolve(root, relativePath);
  try {
    accessSync(absolute, constants.R_OK);
  } catch (error) {
    throw new Error(`Missing or unreadable extension resource: ${relativePath}`);
  }
  files.add(relativePath.replaceAll('\\', '/'));
}

for (const icon of Object.values(manifest.icons || {})) requireFile(icon);
for (const icon of Object.values(manifest.action?.default_icon || {})) requireFile(icon);
requireFile(manifest.background.service_worker);
requireFile(manifest.options_ui.page);
requireFile(manifest.action.default_popup);
for (const entry of manifest.content_scripts || []) {
  for (const script of entry.js || []) requireFile(script);
}

const htmlFiles = [manifest.options_ui.page, manifest.action.default_popup];
for (const relativePath of htmlFiles) {
  const html = readFileSync(resolve(root, relativePath), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1];
    if (!ref.startsWith('http:') && !ref.startsWith('https:')) {
      requireFile(relative(root, resolve(root, dirname(relativePath), ref)));
    }
  }
}

for (const locale of Object.keys(manifest)) void locale;
console.log(`Extension resources validated: ${files.size} files`);

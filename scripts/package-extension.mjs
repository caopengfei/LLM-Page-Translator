// Builds the Chrome Web Store upload package: dist/<name>-<version>.zip
//
// The payload is an allow-list of runtime files — manifest.json, src/, _locales/, icons/,
// LICENSE — so the dev-only trees (node_modules, test/, docs/, scripts/, the package
// manifests) cannot leak in. That is the difference between a ~340 KB upload and the
// ~44 MB checkout the node_modules tree alone accounts for.
//
// The archive is written here instead of through an archiver dependency, for the same
// reason the icon generator rasterizes PNGs by hand: this repo's tooling adds no
// dependencies. Two store rules drive the container details — manifest.json must sit at
// the archive root rather than inside a folder, and no entry may start with "." or "_"
// other than the reserved _locales directory.
//
// Entries are sorted and stamped with a fixed DOS timestamp, so packing the same source
// twice yields byte-identical archives; SOURCE_DATE_EPOCH overrides the stamp.
import { deflateRawSync } from 'node:zlib';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 } from './lib/crc32.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PAYLOAD_ROOTS = ['src', '_locales', 'icons'];
const PAYLOAD_FILES = ['manifest.json', 'LICENSE'];
const RESERVED_LOCALES_DIR = '_locales';
const DEV_TREES = new Set(['node_modules', 'test', 'docs', 'scripts', 'dist', '.git', '.worktrees']);
// Already DEFLATE-compressed: recompressing them stores more bytes than it saves.
const STORE_AS_IS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip']);
const HTML_REF = /(?:src|href)="([^"]+)"/g;
const ABSOLUTE_REF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const MESSAGE_PLACEHOLDER = /^__MSG_(\w+)__$/;

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

const toPosix = (path) => path.replaceAll('\\', '/');

/** Runtime files to package, as paths relative to the extension root, sorted. */
export function collectPayload(rootDir) {
  const paths = [];
  for (const file of PAYLOAD_FILES) {
    if (existsSync(resolve(rootDir, file))) paths.push(file);
    else if (file === 'manifest.json') throw new Error(`No manifest.json in ${rootDir}`);
  }
  for (const dir of PAYLOAD_ROOTS) {
    const base = resolve(rootDir, dir);
    if (!existsSync(base)) throw new Error(`Missing extension directory: ${dir}`);
    for (const file of walk(base)) paths.push(toPosix(relative(rootDir, file)));
  }
  return paths.sort();
}

function htmlReferences(rootDir, page) {
  const html = readFileSync(resolve(rootDir, page), 'utf8');
  const refs = [];
  for (const match of html.matchAll(HTML_REF)) {
    if (ABSOLUTE_REF.test(match[1])) continue;
    refs.push(toPosix(relative(rootDir, resolve(rootDir, dirname(page), match[1]))));
  }
  return refs;
}

/** Every file the manifest (or a page it loads) needs present in the package. */
export function manifestReferences(rootDir, manifest) {
  const refs = new Set();
  // Glob patterns (web_accessible_resources) are resolved by Chrome at runtime, so they
  // cannot be checked against a file list; a pattern is taken as-is.
  const add = (path) => {
    if (typeof path === 'string' && path && !path.includes('*')) refs.add(toPosix(path));
  };

  for (const icon of Object.values(manifest.icons || {})) add(icon);
  for (const icon of Object.values(manifest.action?.default_icon || {})) add(icon);
  for (const script of manifest.background?.scripts || []) add(script);
  add(manifest.background?.service_worker);
  add(manifest.options_ui?.page);
  add(manifest.action?.default_popup);
  add(manifest.side_panel?.default_path);
  add(manifest.devtools_page);
  for (const page of Object.values(manifest.chrome_url_overrides || {})) add(page);
  for (const entry of manifest.content_scripts || []) {
    for (const file of [...(entry.js || []), ...(entry.css || [])]) add(file);
  }
  for (const entry of manifest.web_accessible_resources || []) {
    for (const file of typeof entry === 'string' ? [entry] : entry.resources || []) add(file);
  }
  const pages = [...refs].filter((path) => /\.html?$/i.test(path));
  for (const page of pages) for (const ref of htmlReferences(rootDir, page)) add(ref);

  return refs;
}

function readPngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Resolves a `__MSG_key__` manifest placeholder against the default-locale catalog. */
export function resolveMessage(value, rootDir, defaultLocale) {
  const match = typeof value === 'string' ? value.match(MESSAGE_PLACEHOLDER) : null;
  if (!match) return value;
  const file = resolve(rootDir, `${RESERVED_LOCALES_DIR}/${defaultLocale}/messages.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8'))[match[1]]?.message;
}

/**
 * Store-upload preflight. Returns the checks that passed plus the ones that must block the
 * package; a failure here is a rejection or a broken install at review time, not a warning.
 */
export function verifyPayload({ rootDir, payload, manifest }) {
  const entries = new Set(payload);
  const passed = [];
  const failures = [];

  const references = manifestReferences(rootDir, manifest);
  const missing = [...references].filter((ref) => !entries.has(ref));
  if (missing.length) failures.push(`manifest references files absent from the package: ${missing.join(', ')}`);
  else passed.push(`all ${references.size} manifest references packaged`);

  const reserved = payload.filter((path) => path.split('/').some((segment, index) => {
    const isReserved = segment.startsWith('.') || segment.startsWith('_');
    return isReserved && !(index === 0 && segment === RESERVED_LOCALES_DIR);
  }));
  if (reserved.length) failures.push(`Chrome reserves "." and "_" names outside _locales: ${reserved.join(', ')}`);
  else passed.push('no reserved file names');

  const devFiles = payload.filter((path) => DEV_TREES.has(path.split('/')[0]));
  if (devFiles.length) failures.push(`dev-only files packaged: ${devFiles.slice(0, 5).join(', ')}`);
  else passed.push('payload is runtime files only');

  const locale = manifest.default_locale;
  if (!locale) failures.push('manifest.default_locale is not set');
  else if (!entries.has(`${RESERVED_LOCALES_DIR}/${locale}/messages.json`)) {
    failures.push(`default_locale "${locale}" has no _locales/${locale}/messages.json`);
  } else passed.push(`default locale "${locale}" catalog present`);

  const parts = String(manifest.version || '').split('.');
  const badVersion = !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(manifest.version || '')
    || parts.some((part) => Number(part) > 65535);
  if (badVersion) failures.push(`manifest.version "${manifest.version}" is not 1-4 integers of 0-65535`);
  else passed.push(`version ${manifest.version}`);

  const unresolved = [];
  const iconGroups = [manifest.icons, manifest.action?.default_icon];
  for (const group of iconGroups) {
    for (const [size, path] of Object.entries(group || {})) {
      if (!entries.has(toPosix(path))) continue; // already reported as a missing reference
      const png = readPngSize(readFileSync(resolve(rootDir, path)));
      if (png && (String(png.width) !== size || png.width !== png.height)) {
        unresolved.push(`${path} is ${png.width}x${png.height}, declared as ${size}`);
      }
    }
  }
  if (unresolved.length) failures.push(`icon bitmaps do not match declared sizes: ${unresolved.join(', ')}`);
  else passed.push('icon bitmaps match declared sizes');

  const untranslated = [manifest.name, manifest.description, manifest.action?.default_title]
    .filter((value) => MESSAGE_PLACEHOLDER.test(value || ''))
    .filter((value) => !resolveMessage(value, rootDir, locale));
  if (untranslated.length) {
    failures.push(`manifest placeholders resolve to nothing in _locales/${locale}: ${untranslated.join(', ')}`);
  } else passed.push('name/description/title placeholders resolve');

  return { passed, failures };
}

function dosStamp() {
  const override = Number(process.env.SOURCE_DATE_EPOCH);
  const when = Number.isFinite(override) && override > 0
    ? new Date(override * 1000)
    : new Date(Date.UTC(1980, 0, 1));
  const time = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  // The DOS date field starts at 1980 and packs the year in 7 bits, so an epoch outside
  // that window is clamped rather than written out of range.
  const year = Math.min(2107, Math.max(1980, when.getUTCFullYear()));
  const date = ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  return { time, date };
}

/** Writes a ZIP archive: store + deflate entries, central directory, end-of-central record. */
export function buildZip(files) {
  const { time, date } = dosStamp();
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const localParts = [];
  const centralParts = [];
  const entries = [];
  let offset = 0;

  for (const { name, data } of ordered) {
    const stored = STORE_AS_IS.has(extname(name).toLowerCase());
    const body = stored ? data : deflateRawSync(data, { level: 9 });
    const method = stored ? 0 : 8;
    const checksum = crc32(data);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // filenames are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, body);
    centralParts.push(central, nameBytes);
    entries.push({ name, size: data.length, packed: body.length, stored });
    offset += local.length + nameBytes.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return { buffer: Buffer.concat([...localParts, centralDirectory, end]), entries };
}

export function packageFileName(manifest, rootDir) {
  const name = resolveMessage(manifest.name, rootDir, manifest.default_locale) || manifest.name || 'extension';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'extension'}-${manifest.version}.zip`;
}

/** Collects, verifies and writes the package. Throws with `.failures` if a check fails. */
export function packageExtension({ rootDir = root, outDir = resolve(root, 'dist') } = {}) {
  const manifest = JSON.parse(readFileSync(resolve(rootDir, 'manifest.json'), 'utf8'));
  const payload = collectPayload(rootDir);
  const { passed, failures } = verifyPayload({ rootDir, payload, manifest });
  if (failures.length) {
    const error = new Error(`package check failed:\n  - ${failures.join('\n  - ')}`);
    error.failures = failures;
    throw error;
  }

  const { buffer, entries } = buildZip(payload.map((name) => ({ name, data: readFileSync(resolve(rootDir, name)) })));
  mkdirSync(outDir, { recursive: true });
  const zipPath = resolve(outDir, packageFileName(manifest, rootDir));
  writeFileSync(zipPath, buffer);

  return { zipPath, buffer, entries, manifest, passed };
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function usage() {
  return [
    'Usage: npm run package [-- --out <dir>]',
    '',
    'Builds the Chrome Web Store upload archive from the runtime files only.',
    '  --out <dir>   Output directory (default: dist)'
  ].join('\n');
}

function main(argv) {
  let outDir = resolve(root, 'dist');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      if (!argv[i + 1]) throw new Error(`${arg} needs a directory`);
      outDir = resolve(process.cwd(), argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return null;
    } else {
      throw new Error(`unknown option: ${arg}\n\n${usage()}`);
    }
  }

  const { zipPath, buffer, entries, manifest, passed } = packageExtension({ outDir });
  const unpacked = entries.reduce((total, entry) => total + entry.size, 0);
  const largest = [...entries].sort((a, b) => b.size - a.size).slice(0, 4);

  console.log(`Packed ${resolveMessage(manifest.name, root, manifest.default_locale)} ${manifest.version}`);
  console.log(`  payload   ${entries.length} files, ${kib(unpacked)} unpacked`);
  console.log(`  archive   ${toPosix(relative(root, zipPath))} — ${kib(buffer.length)} (${((buffer.length / unpacked) * 100).toFixed(0)}% of payload)`);
  console.log(`  largest   ${largest.map((entry) => `${entry.name} ${kib(entry.size)}`).join(', ')}`);
  console.log(`  checks    ${passed.join('; ')}`);
  console.log('Upload the archive at https://chrome.google.com/webstore/devconsole (manifest.json is at the root).');
  return zipPath;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

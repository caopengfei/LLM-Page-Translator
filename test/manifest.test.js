// Verifies manifest.json structure and shared EXT_CONSTANTS (Task 1 scaffold).
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/shared/constants.js';

const testDir = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const C = globalThis.EXT_CONSTANTS;

describe('manifest.json', () => {
  it('is Manifest V3 with required permissions', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'scripting']));
    expect(manifest.host_permissions).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*']));
  });

  it('content_scripts js files exist on disk (for files defined so far)', () => {
    const known = ['src/shared/constants.js'];
    manifest.content_scripts[0].js
      .filter((f) => known.includes(f))
      .forEach((f) => expect(existsSync(resolve(root, f))).toBe(true));
    expect(manifest.content_scripts[0].js[manifest.content_scripts[0].js.length - 1])
      .toBe('src/content/main.js');
  });

  it('background service worker is an ESM module', () => {
    expect(manifest.background.type).toBe('module');
  });
});

describe('EXT_CONSTANTS', () => {
  it('message types are unique non-empty strings', () => {
    const values = Object.values(C.MSG);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    values.forEach((v) => expect(typeof v).toBe('string'));
  });

  it('defaults target language to zh-CN and has batch limits', () => {
    expect(C.DEFAULT_CONFIG.targetLang).toBe('zh-CN');
    expect(C.BATCH_MAX_ITEMS).toBeGreaterThan(0);
    expect(C.BATCH_MAX_CHARS).toBeGreaterThan(0);
  });
});

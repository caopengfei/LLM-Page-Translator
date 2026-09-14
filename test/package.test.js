// 守护上架包:只含运行时文件、manifest.json 在压缩包根目录、且容器本身可被真实解压器
// 读取(ZIP 由 scripts/package-extension.mjs 手写,格式细节最值得钉住)。
import { describe, it, expect, afterAll } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildZip,
  collectPayload,
  manifestReferences,
  packageExtension,
  packageFileName,
  verifyPayload
} from '../scripts/package-extension.mjs';

const testDir = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, '..');

const outDir = mkdtempSync(join(tmpdir(), 'ext-package-'));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// 独立的 CRC-32 实现(逐位、无查表),用来校验包里记录的校验和,而不是复用被测实现。
function crc32Of(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** 按中央目录逐条解出内容,顺带校验 local header 偏移、长度与 CRC。 */
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(EOCD);
  expect(eocd, 'end of central directory record').toBeGreaterThan(0);
  const total = buffer.readUInt16LE(eocd + 10);
  expect(buffer.readUInt32LE(eocd + 16) + buffer.readUInt32LE(eocd + 12)).toBe(eocd);

  const entries = [];
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i += 1) {
    expect(buffer.readUInt32LE(cursor), 'central directory header').toBe(0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const packed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    expect(buffer.readUInt32LE(localOffset), `local header for ${name}`).toBe(0x04034b50);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    expect(buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength)).toBe(name);

    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = buffer.subarray(start, start + packed);
    const data = method === 0 ? body : inflateRawSync(body);
    expect(data.length, `${name} uncompressed size`).toBe(size);
    expect(crc32Of(data), `${name} crc`).toBe(checksum);

    entries.push({ name, data, method });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const first = packageExtension({ outDir });
const entries = readZip(first.buffer);

describe('package-extension', () => {
  it('puts manifest.json at the archive root', () => {
    expect(entries.some((entry) => entry.name === 'manifest.json')).toBe(true);
    // 商店会拒绝「外面还套一层目录」的包,也拒绝绝对路径
    entries.forEach((entry) => {
      expect(entry.name.startsWith('/'), entry.name).toBe(false);
      expect(entry.name.includes('..'), entry.name).toBe(false);
    });
  });

  it('ships runtime files only, never the checkout', () => {
    const payload = collectPayload(root);
    payload.forEach((path) => {
      const top = path.split('/')[0];
      expect(['src', '_locales', 'icons', 'manifest.json', 'LICENSE'], path).toContain(top);
      expect(path.startsWith('.'), path).toBe(false);
      // Chrome 保留 "_" 前缀,只有 _locales 例外
      if (top !== '_locales') expect(top.startsWith('_'), path).toBe(false);
    });
  });

  it('keeps every manifest reference inside the package', () => {
    const names = new Set(entries.map((entry) => entry.name));
    const references = manifestReferences(root, manifest);
    expect(references.size).toBeGreaterThan(0);
    references.forEach((ref) => expect(names.has(ref), `${ref} should be packaged`).toBe(true));
    expect(names.has(manifest.background.service_worker)).toBe(true);
    expect(names.has(manifest.action.default_popup)).toBe(true);
  });

  it('round-trips file contents through the archive', () => {
    const onDisk = readFileSync(resolve(root, 'src/content/main.js'));
    const packed = entries.find((entry) => entry.name === 'src/content/main.js');
    expect(packed.data.equals(onDisk)).toBe(true);
    // 已压缩的 PNG 直接存储,再 deflate 一次只会更大
    expect(entries.find((entry) => entry.name === 'icons/icon128.png').method).toBe(0);
    expect(packed.method).toBe(8);
  });

  it('is byte-identical across runs on the same source', () => {
    expect(packageExtension({ outDir }).buffer.equals(first.buffer)).toBe(true);
  });

  it('honours SOURCE_DATE_EPOCH and clamps dates the DOS field cannot hold', () => {
    const files = [{ name: 'a.js', data: Buffer.from('const a = 1;\n') }];
    const original = process.env.SOURCE_DATE_EPOCH;
    try {
      process.env.SOURCE_DATE_EPOCH = '1700000000';
      const stamped = buildZip(files).buffer;
      expect(stamped.equals(first.buffer)).toBe(false);
      expect(buildZip(files).buffer.equals(stamped)).toBe(true); // 同一时间戳仍可复现
      const localTime = stamped.readUInt16LE(10);
      const localDate = stamped.readUInt16LE(12);
      expect([localTime, localDate]).toEqual([45482, 22382]); // 2023-11-14 22:13:20 UTC

      process.env.SOURCE_DATE_EPOCH = '1'; // 1970:早于 DOS 日期起点,必须被夹住而不是抛错
      expect(() => buildZip(files)).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = original;
    }
  });

  it('names the archive after the localized name and version', () => {
    expect(packageFileName(manifest, root)).toBe(`llm-page-translator-${manifest.version}.zip`);
    expect(first.zipPath.endsWith(`llm-page-translator-${manifest.version}.zip`)).toBe(true);
  });

  it('fails the preflight when a referenced file is missing from the payload', () => {
    const payload = collectPayload(root).filter((path) => path !== manifest.action.default_popup);
    const { failures } = verifyPayload({ rootDir: root, payload, manifest });
    expect(failures.join('\n')).toContain(manifest.action.default_popup);
  });

  it('fails the preflight on dev files and on reserved names', () => {
    const withDev = verifyPayload({
      rootDir: root,
      payload: [...collectPayload(root), 'node_modules/vitest/package.json'],
      manifest
    });
    expect(withDev.failures.join('\n')).toContain('dev-only files packaged');

    const withReserved = verifyPayload({
      rootDir: root,
      payload: [...collectPayload(root), 'src/_scratch.js'],
      manifest
    });
    expect(withReserved.failures.join('\n')).toContain('_scratch.js');
  });

  it('passes the preflight on the real payload', () => {
    const { passed, failures } = verifyPayload({ rootDir: root, payload: collectPayload(root), manifest });
    expect(failures).toEqual([]);
    expect(passed.length).toBeGreaterThanOrEqual(6);
  });
});

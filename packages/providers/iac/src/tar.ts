import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(header: Buffer, offset: number, length: number): number {
  const text = field(header, offset, length).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/**
 * Extract one regular file from a gzipped tar archive (ustar or GNU, as
 * produced by OpenTofu's release builds). Returns undefined when absent.
 */
export function extractFromTarGz(archive: Buffer, name: string): Buffer | undefined {
  const tar = gunzipSync(archive);
  let longName: string | undefined;
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = field(header, 345, 155);
    const entryName = longName ?? (prefix !== '' ? `${prefix}/` : '') + field(header, 0, 100);
    const dataStart = offset + BLOCK;
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    longName = undefined;

    if (type === 'L') {
      // GNU long name: the data block holds the next entry's name.
      longName = field(tar.subarray(dataStart, dataStart + size), 0, size);
      continue;
    }
    if ((type === '0' || type === '\0') && entryName.replace(/^\.\//, '') === name) {
      return Buffer.from(tar.subarray(dataStart, dataStart + size));
    }
  }
  return undefined;
}

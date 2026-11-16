import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, promises as fs } from 'fs';
import { dirname, resolve, sep } from 'path';

/**
 * Penyimpanan file lokal (NAS/disk). Antarmuka sengaja sederhana agar mudah diganti
 * dengan adapter S3-compatible (save/read/exists) tanpa mengubah modul lain.
 */
@Injectable()
export class StorageService {
  private readonly root: string;
  constructor(config: ConfigService) {
    this.root = resolve(config.get('STORAGE_DIR', './storage'));
  }

  resolve(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Path storage tidak valid');
    return p;
  }

  async save(key: string, data: Buffer) {
    const p = this.resolve(key);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return key;
  }

  async exists(path: string) {
    try { await fs.access(path); return true; } catch { return false; }
  }

  stream(key: string) {
    return createReadStream(this.resolve(key));
  }

  async read(key: string) {
    return fs.readFile(this.resolve(key));
  }
}

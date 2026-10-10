import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  dirs: DirEntry[];
  /** Present only for the empty-path (drive picker) result on Windows. */
  roots?: DirEntry[];
}

/**
 * List a directory's immediate subdirectories for the console's picker. An
 * empty path returns the Windows drive list (or the home directory elsewhere).
 * Never reads file contents; localhost + UI-token gated at the server layer.
 */
export async function browseDirectory(input?: string): Promise<DirListing> {
  const requested = (input ?? '').trim();
  if (!requested) {
    if (platform() === 'win32') {
      return { path: '', dirs: [], roots: await windowsDrives() };
    }
    return listDir(homedir());
  }
  return listDir(requested);
}

async function listDir(requested: string): Promise<DirListing> {
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new Error(`目录不存在或不可访问：${requested}`);
  }
  const info = await stat(real).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`路径不是目录：${real}`);

  const entries = await readdir(real, { withFileTypes: true });
  const dirs: DirEntry[] = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: join(real, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(real);
  return { path: real, dirs, ...(parent && parent !== real ? { parent } : {}) };
}

async function windowsDrives(): Promise<DirEntry[]> {
  const drives: DirEntry[] = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      const info = await stat(root);
      if (info.isDirectory()) drives.push({ name: root, path: root });
    } catch {
      // drive not present
    }
  }
  return drives;
}

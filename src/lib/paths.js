import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
export const OUTPUT_DIR = path.join(DATA_DIR, 'posts');
export const EXAMPLE_DIR = path.join(DATA_DIR, 'examples');
export const LOG_DIR = path.join(DATA_DIR, 'logs');

export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
export const SITE_FILE = path.join(DATA_DIR, 'wp-site.json');

export function ensureDirs() {
  for (const dir of [DATA_DIR, THUMB_DIR, OUTPUT_DIR, EXAMPLE_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

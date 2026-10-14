// scripts/env.mjs
// Loads KEY=VALUE lines from the repo's .env into process.env, for running scripts locally.
// Import it first: `import './env.mjs';`
// Values already set in the environment win (so GitHub Actions secrets are never overridden).
// If there is no .env file, this does nothing.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (existsSync(envPath)) {
  const raw = readFileSync(envPath);
  // PowerShell's Out-File / ">" writes UTF-16; Set-Content writes ANSI/UTF-8. Handle both.
  const isUtf16 = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe;
  const text = (isUtf16 ? raw.toString('utf16le') : raw.toString('utf8')).replace(/^﻿/, '');

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, rawValue] = m;
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

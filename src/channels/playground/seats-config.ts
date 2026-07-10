import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../../env.js';

export interface SeatEntry {
  label: string;
  folder: string;
  slug?: string;
  role?: 'owner' | 'ta' | 'member';
}
export interface SeatsConfig {
  password: string;
  seats: SeatEntry[];
}

/**
 * Resolve the effective seat password. `PLAYGROUND_SEAT_PASSWORD` (checked
 * in `process.env` first, then the repo's `.env` via `readEnvFile`) takes
 * precedence over the JSON file's `password` field whenever it's set to a
 * nonempty value. Falls back to `jsonPassword` for backward compatibility
 * with installs that still keep the password in
 * `config/playground-seats.json` (a tracked file — never write a real
 * password back into it).
 */
export function resolveSeatPassword(jsonPassword: string): string {
  const envPassword =
    process.env.PLAYGROUND_SEAT_PASSWORD || readEnvFile(['PLAYGROUND_SEAT_PASSWORD']).PLAYGROUND_SEAT_PASSWORD;
  return envPassword || jsonPassword;
}

function readSeatsFile(): SeatsConfig {
  try {
    const p = path.join(process.cwd(), 'config', 'playground-seats.json');
    if (!fs.existsSync(p)) return { password: '', seats: [] };
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SeatsConfig;
  } catch {
    return { password: '', seats: [] };
  }
}

export function readSeatsConfig(): SeatsConfig {
  const fileConfig = readSeatsFile();
  return { ...fileConfig, password: resolveSeatPassword(fileConfig.password) };
}

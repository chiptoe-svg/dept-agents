import fs from 'fs';
import path from 'path';

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

export function readSeatsConfig(): SeatsConfig {
  try {
    const p = path.join(process.cwd(), 'config', 'playground-seats.json');
    if (!fs.existsSync(p)) return { password: '', seats: [] };
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SeatsConfig;
  } catch {
    return { password: '', seats: [] };
  }
}

import fs from 'fs';
import path from 'path';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
}

const CLASS_BASE_PATH = path.join(process.cwd(), 'data', 'class-shared-students.md');

export function handleGetClassBase(): ApiResult<{ content: string }> {
  try {
    const content = fs.existsSync(CLASS_BASE_PATH) ? fs.readFileSync(CLASS_BASE_PATH, 'utf-8') : '';
    return { status: 200, body: { content } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handlePutClassBase(body: unknown): ApiResult<{ ok: true }> {
  try {
    if (typeof body !== 'object' || body === null || typeof (body as { content?: unknown }).content !== 'string') {
      return { status: 400, body: { error: 'body must be { content: string }' } };
    }
    const { content } = body as { content: string };
    fs.mkdirSync(path.dirname(CLASS_BASE_PATH), { recursive: true });
    fs.writeFileSync(CLASS_BASE_PATH, content, 'utf-8');
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

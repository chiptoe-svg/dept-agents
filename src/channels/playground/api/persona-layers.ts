import { getEffectivePersonaLayers } from '../../../persona-layers.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
}

export function handlePersonaLayers(draftFolder: string): ApiResult<ReturnType<typeof getEffectivePersonaLayers>> {
  try {
    return { status: 200, body: getEffectivePersonaLayers(draftFolder) };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * Model-provider registry barrel.
 *
 * Each adapter file exports its `ModelProviderAdapter` object. This barrel
 * imports them and populates the registry imperatively (no top-level
 * `registerModelProvider` calls in adapter files — those would fire
 * before this file's `registry` const initializes due to ES-module
 * import hoisting).
 *
 * Adding a provider:
 *   1. Create `src/model-providers/<name>.ts` exporting a const adapter
 *      that conforms to `ModelProviderAdapter`.
 *   2. Import it here and add to the `BUILTIN_ADAPTERS` array.
 *   3. The provider is now selectable via `agent_provider = '<name>'` and
 *      will appear in `/model` listings.
 */
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
import { omlxAdapter } from './omlx.js';
import type { ModelProviderAdapter } from './types.js';

const BUILTIN_ADAPTERS: ModelProviderAdapter[] = [anthropicAdapter, openaiAdapter, omlxAdapter];

const registry = new Map<string, ModelProviderAdapter>();
for (const adapter of BUILTIN_ADAPTERS) {
  registry.set(adapter.name, adapter);
}

export function registerModelProvider(adapter: ModelProviderAdapter): void {
  registry.set(adapter.name, adapter);
}

export function getModelProvider(name: string | null): ModelProviderAdapter | undefined {
  if (!name) return undefined;
  return registry.get(name.toLowerCase());
}

export function listRegisteredProviders(): string[] {
  return [...registry.keys()].sort();
}

/** Test helper. */
export function _resetRegistryForTest(): void {
  registry.clear();
  for (const adapter of BUILTIN_ADAPTERS) {
    registry.set(adapter.name, adapter);
  }
}

export type { ModelHint, ModelProviderAdapter, ParsedModel, AuthHeader } from './types.js';

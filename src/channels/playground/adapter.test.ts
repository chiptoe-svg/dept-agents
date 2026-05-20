/**
 * Tests for playground adapter deliver — meta forwarding.
 *
 * Strategy: vi.mock intercepts sse.js and channel-registry.js before the
 * adapter module loads. Importing adapter.js triggers registerChannelAdapter
 * (via the mocked registry), which captures the factory. We invoke
 * adapter.deliver directly and assert the data passed to pushToDraft.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the last pushToDraft call across all tests.
let lastPushArgs: { folder: string; eventName: string; data: unknown } | undefined;

// Capture the registered adapter factory.
let registeredFactory: (() => unknown) | undefined;

vi.mock('./sse.js', () => ({
  pushToDraft: (folder: string, eventName: string, data: unknown) => {
    lastPushArgs = { folder, eventName, data };
  },
}));

vi.mock('../channel-registry.js', () => ({
  registerChannelAdapter: (_name: string, opts: { factory: () => unknown }) => {
    registeredFactory = opts.factory as () => unknown;
  },
}));

// Import the adapter module AFTER mocks are declared — vitest hoists vi.mock()
// calls before imports, so the mocks are in place when adapter.ts executes.
await import('./adapter.js');

describe('playground adapter deliver — meta forwarding', () => {
  let adapter: {
    deliver: (platformId: string, threadId: null, message: Record<string, unknown>) => Promise<string | undefined>;
  };

  beforeEach(() => {
    lastPushArgs = undefined;
    // Create a fresh adapter instance for each test via the captured factory.
    adapter = (registeredFactory as () => typeof adapter)();
  });

  it('passes tokens/latencyMs/provider/model from message.meta into pushToDraft data', async () => {
    await adapter.deliver('playground:draft_demo', null, {
      kind: 'chat',
      content: { text: 'hi' },
      meta: {
        tokens: { input: 100, output: 50 },
        latencyMs: 1234,
        provider: 'claude',
        model: 'claude-haiku-4-5',
      },
    });

    expect(lastPushArgs).toBeDefined();
    expect(lastPushArgs!.eventName).toBe('message');
    const data = lastPushArgs!.data as Record<string, unknown>;
    expect(data.tokens).toEqual({ input: 100, output: 50 });
    expect(data.latencyMs).toBe(1234);
    expect(data.provider).toBe('claude');
    expect(data.model).toBe('claude-haiku-4-5');
    // Core fields still present
    expect(data.kind).toBe('chat');
    expect(data.content).toEqual({ text: 'hi' });
  });

  it('omits meta fields when message.meta is absent', async () => {
    await adapter.deliver('playground:draft_demo', null, { kind: 'chat', content: { text: 'hi' } });

    expect(lastPushArgs).toBeDefined();
    const data = lastPushArgs!.data as Record<string, unknown>;
    expect(data.tokens).toBeUndefined();
    expect(data.latencyMs).toBeUndefined();
    expect(data.provider).toBeUndefined();
    expect(data.model).toBeUndefined();
    expect(data.kind).toBe('chat');
  });

  it('omits token field when only one of tokens_in/tokens_out is non-null (no partial tokens)', async () => {
    // tokens object in meta itself requires both to be present (built in delivery.ts)
    // If meta.tokens is undefined, the data should not include it.
    await adapter.deliver('playground:draft_demo', null, {
      kind: 'chat',
      content: { text: 'hi' },
      meta: { latencyMs: 500, provider: 'claude' },
    });

    expect(lastPushArgs).toBeDefined();
    const data = lastPushArgs!.data as Record<string, unknown>;
    expect(data.tokens).toBeUndefined();
    expect(data.latencyMs).toBe(500);
    expect(data.provider).toBe('claude');
    expect(data.model).toBeUndefined();
  });

  it('strips playground: prefix from platform id when resolving draft folder', async () => {
    await adapter.deliver('playground:my_folder', null, { kind: 'chat', content: 'hello' });
    expect(lastPushArgs!.folder).toBe('my_folder');
  });
});

/**
 * Greying-rule for the Models tab. Pure function: inputs are policy +
 * cred state + reachability, output is the {state, source, actionLabel}
 * triple the frontend renders verbatim.
 *
 * Truth table (precedence top to bottom):
 *   1. !policy.allow                  -> HIDDEN
 *   2. local-only && !reachable       -> GREYED + "test connection"
 *   3. local-only && reachable        -> AVAILABLE + source=local
 *   4. policy.provideDefault          -> AVAILABLE + source=class-pool
 *   5. has personal creds             -> AVAILABLE + source=personal-{oauth|key}
 *   6. policy.allowByo                -> GREYED + "add api key" or "connect"
 *   7. (else)                         -> GREYED + "ask instructor"
 */

export type ProviderState = 'AVAILABLE' | 'GREYED' | 'HIDDEN';
export type ProviderSource = 'personal-oauth' | 'personal-key' | 'class-pool' | 'local' | null;

export interface SpecFacts {
  id: string;
  displayName: string;
  catalogModels: Array<{ id: string; modelProvider: string }>;
  hasReachabilityProbe: boolean;
  isLocalOnly: boolean;
  hasOauthMethod: boolean;
  hasApiKeyMethod: boolean;
}

export interface ProviderPolicy {
  allow: boolean;
  provideDefault: boolean;
  allowByo: boolean;
}

export interface CredState {
  hasOAuth: boolean;
  hasApiKey: boolean;
}

export interface DerivedProviderState {
  state: ProviderState;
  source: ProviderSource;
  actionLabel: string | null;
}

export function deriveProviderState(input: {
  spec: SpecFacts;
  policy: ProviderPolicy;
  creds: CredState;
  reachable: boolean;
}): DerivedProviderState {
  const { spec, policy, creds, reachable } = input;

  if (!policy.allow) return { state: 'HIDDEN', source: null, actionLabel: null };

  if (spec.isLocalOnly) {
    if (!reachable) return { state: 'GREYED', source: null, actionLabel: 'test connection' };
    return { state: 'AVAILABLE', source: 'local', actionLabel: 'settings' };
  }

  if (policy.provideDefault) {
    return {
      state: 'AVAILABLE',
      source: 'class-pool',
      actionLabel: policy.allowByo ? 'use my own' : 'manage',
    };
  }

  if (creds.hasOAuth) return { state: 'AVAILABLE', source: 'personal-oauth', actionLabel: 'manage' };
  if (creds.hasApiKey) return { state: 'AVAILABLE', source: 'personal-key', actionLabel: 'manage' };

  if (policy.allowByo) {
    const action = spec.hasOauthMethod ? 'connect' : 'add api key';
    return { state: 'GREYED', source: null, actionLabel: action };
  }

  return { state: 'GREYED', source: null, actionLabel: 'ask instructor' };
}

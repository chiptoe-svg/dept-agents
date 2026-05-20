export interface LibraryEntry {
  /** Stable filename-safe name; matches the JSON file's basename without extension. */
  name: string;
  /** One-line description shown in the library list. */
  description: string;
  /** Markdown persona body (CLAUDE.local.md content). */
  persona: string;
  /** Preferred agent provider (claude / codex / opencode / ollama). */
  preferredProvider?: string;
  /** Preferred model id (matches model-catalog ids). */
  preferredModel?: string;
  /** Skills enabled in this configuration. */
  skills?: string[];
}

export type LibraryTier = 'default' | 'class' | 'my';

export interface AllTiers {
  default: LibraryEntry[];
  class: LibraryEntry[];
  my: LibraryEntry[];
}

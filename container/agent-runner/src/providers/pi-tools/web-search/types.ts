export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
export type SearchBackend = (query: string, count: number) => Promise<SearchResult[]>;

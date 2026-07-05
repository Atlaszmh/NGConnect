export interface NzbResult {
  guid: string;
  rowId: string;
  title: string;
  link: string;
  category: string;
  categoryId: number | null;
  sizeBytes: number;
  pubDate: string;
  grabs: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  season: number | null;
  episode: number | null;
}

export type SortKey = 'title' | 'category' | 'pubDate' | 'sizeBytes' | 'grabs';
export type SortDir = 'asc' | 'desc';
export type GrabState = 'idle' | 'sending' | 'grabbed' | 'rejected' | 'error';

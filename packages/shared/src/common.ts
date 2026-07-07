export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

export interface PagedQuery extends PaginationQuery {
  cursor?: string;
}

export interface ImageSet {
  poster?: string | null;
  backdrop?: string | null;
  still?: string | null;
  logo?: string | null;
}

export interface IdName {
  id: string;
  name: string;
}

export interface DateRange {
  from?: string;
  to?: string;
}

export interface MatchScore {
  /** 0..100 */
  score: number;
}

/**
 * Pagination parameters for list queries.
 */
export interface PaginationParams {
  page: number;
  limit: number;
}

/**
 * Paginated result wrapper.
 */
export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

/**
 * Create a paginated result from data and total count.
 */
export function paginate<T>(
  data: T[],
  total: number,
  params: PaginationParams,
): PaginatedResult<T> {
  const totalPages = Math.ceil(total / params.limit);
  return {
    data,
    meta: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages,
      hasNext: params.page < totalPages,
      hasPrev: params.page > 1,
    },
  };
}

/**
 * Calculate skip value for pagination.
 */
export function getSkip(params: PaginationParams): number {
  return (params.page - 1) * params.limit;
}

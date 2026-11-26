// Turns any error a route throws into an HTTP response.
//
// The business rules live in the database (constraints, functions,
// procedures, triggers), so most errors arrive as PostgreSQL errors with a
// SQLSTATE code. This table is the only place that decides which HTTP status
// each code becomes; the routes never catch errors themselves.

const STATUS_BY_SQLSTATE: Record<string, number> = {
  P0002: 404, // no_data_found: unknown customer, product or order
  '22023': 422, // invalid_parameter_value: input the procedure refused
  '23514': 422, // check_violation
  '23503': 409, // foreign_key_violation
  '23505': 409, // unique_violation
  SH001: 409, // insufficient stock
  SH002: 409, // invalid status change
  SH003: 422, // order without items
  SH005: 409, // stale version (optimistic locking)
  SH006: 409, // too many pending orders
  // Retryable codes reach this table only after api/src/retry.ts gave up.
  '40001': 503, // serialization_failure
  '40P01': 503, // deadlock_detected
};

export type ErrorBody = {
  error: string;
  code: string;
  detail?: string;
  hint?: string;
};

type AnyError = {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  statusCode?: number;
  validation?: unknown;
};

export function toHttpError(thrown: unknown): { status: number; body: ErrorBody } {
  // Fastify types what a route throws as unknown: it can be anything.
  const error: AnyError =
    thrown instanceof Error ? (thrown as AnyError) : { message: String(thrown) };

  // Fastify rejected the request before any SQL ran: bad JSON, wrong types,
  // missing fields (the JSON schemas on each route).
  if (error.validation) {
    return { status: 400, body: { error: error.message, code: 'VALIDATION' } };
  }
  if (error.statusCode && error.statusCode < 500) {
    return { status: error.statusCode, body: { error: error.message, code: error.code ?? 'BAD_REQUEST' } };
  }

  const status = error.code ? STATUS_BY_SQLSTATE[error.code] : undefined;
  if (!status) {
    // Anything unexpected: do not leak SQL or stack traces to the client.
    return { status: 500, body: { error: 'internal error', code: 'INTERNAL' } };
  }

  const body: ErrorBody = { error: error.message, code: error.code! };
  if (error.detail) body.detail = error.detail;
  if (error.hint) body.hint = error.hint;
  return { status, body };
}

// Thrown by routes for a resource that a plain SELECT did not find, so it goes
// through the same mapping as the database's own P0002.
export function notFound(message: string): AnyError {
  return Object.assign(new Error(message), { code: 'P0002' });
}

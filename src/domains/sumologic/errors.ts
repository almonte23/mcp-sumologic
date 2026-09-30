// Classify Sumo Logic failures so callers (AI skills) can tell a real failure
// apart from an empty result, and know whether retrying makes sense.

export type SumoErrorKind =
  | 'rate_limited'
  | 'auth'
  | 'forbidden'
  | 'invalid_query'
  | 'invalid_input'
  | 'not_found'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'network'
  | 'unknown';

const RETRY_HINT: Record<SumoErrorKind, string> = {
  rate_limited:
    'Sumo Logic is rate limiting this access key. Wait ~30s and retry; avoid firing many searches at once.',
  auth: 'Credentials were rejected. Check SUMO_API_ID / SUMO_API_KEY and ENDPOINT (region).',
  forbidden: "The access key's role lacks the capability for this call.",
  invalid_query:
    'Sumo Logic rejected the query or parameters. Fix the query syntax; retrying unchanged will fail again.',
  invalid_input:
    'A tool parameter was invalid (time range, time zone, bucket, field name). Fix the input and retry.',
  not_found:
    'The resource or search job was not found (jobs expire when not polled). Retrying the whole search usually works.',
  timeout:
    'The search did not finish in time. Narrow the time range or scope (_index/_sourceCategory) and retry.',
  cancelled:
    'Sumo Logic cancelled the search job. Retry once; if it repeats, narrow the query.',
  unavailable: 'Sumo Logic is temporarily unavailable. Retry shortly.',
  network: 'Network error talking to Sumo Logic. Retry shortly.',
  unknown: 'Unexpected failure.',
};

export class SumoSearchError extends Error {
  readonly kind: SumoErrorKind;
  readonly statusCode?: number;
  readonly sumoCode?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    kind: SumoErrorKind,
    extra: { statusCode?: number; sumoCode?: string } = {},
  ) {
    super(message);
    this.name = 'SumoSearchError';
    this.kind = kind;
    this.statusCode = extra.statusCode;
    this.sumoCode = extra.sumoCode;
    this.retryable = [
      'rate_limited',
      'not_found',
      'timeout',
      'cancelled',
      'unavailable',
      'network',
    ].includes(kind);
  }

  get hint(): string {
    return RETRY_HINT[this.kind];
  }
}

const NETWORK_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
];

export function isNetworkError(err: any): boolean {
  const code = err?.cause?.code ?? err?.error?.code ?? err?.code;
  return NETWORK_CODES.includes(code);
}

export function statusCodeOf(err: any): number | undefined {
  return err?.statusCode ?? err?.response?.statusCode;
}

export function classifyError(err: unknown): SumoSearchError {
  if (err instanceof SumoSearchError) {
    return err;
  }
  const e = err as any;
  const statusCode = statusCodeOf(e);
  const body = e?.error ?? e?.response?.body;
  const sumoCode: string | undefined =
    body?.code ?? body?.errors?.[0]?.code ?? undefined;
  const sumoMessage: string | undefined =
    body?.message ?? body?.errors?.[0]?.message ?? undefined;
  const message =
    sumoMessage && statusCode
      ? `${statusCode} ${sumoCode ?? ''}: ${sumoMessage}`.replace('  ', ' ')
      : (e?.message ?? String(err));

  let kind: SumoErrorKind = 'unknown';
  if (statusCode === 429 || sumoCode === 'rate.limit.exceeded')
    kind = 'rate_limited';
  else if (statusCode === 401) kind = 'auth';
  else if (statusCode === 403) kind = 'forbidden';
  else if (statusCode === 404) kind = 'not_found';
  else if (statusCode === 400 || statusCode === 422) kind = 'invalid_query';
  else if (statusCode && statusCode >= 500) kind = 'unavailable';
  else if (isNetworkError(e)) kind = 'network';

  return new SumoSearchError(message, kind, { statusCode, sumoCode });
}

// Text returned to the MCP client for a failed tool call. The explicit
// "not an empty result" line exists because skills have mistaken silent
// failures for quiet windows.
export function formatToolError(err: unknown): string {
  const e = err instanceof SumoSearchError ? err : classifyError(err);
  return (
    `Error: ${e.message}\n` +
    JSON.stringify(
      {
        error: {
          kind: e.kind,
          retryable: e.retryable,
          statusCode: e.statusCode,
          sumoCode: e.sumoCode,
          hint: e.hint,
          note: 'This search FAILED. It is not an empty result; do not treat the window as clean.',
        },
      },
      null,
      2,
    )
  );
}

import moment from 'moment';
import * as Sumo from '@/lib/sumologic/client.js';
import { maskSensitiveInfo } from '@/utils/pii.js';

export interface SearchResult {
  // 'messages' for raw log searches, 'records' for aggregate queries
  // (queries containing operators like `count`, `sum`, `avg`, `by`, `timeslice`).
  type: 'messages' | 'records';
  // Column definitions returned by Sumo Logic (present for aggregate results).
  fields?: any[];
  // Raw log messages (populated when type === 'messages').
  messages?: any[];
  // Aggregate result rows (populated when type === 'records').
  records?: any[];
}

// Sumo Logic caps a single results page at 10000 rows.
const MAX_ROWS = 10000;
// Default number of rows to return when the caller doesn't specify a limit.
const DEFAULT_LIMIT = 100;
// Poll the job status at this interval until it reaches a terminal state.
const POLL_INTERVAL_MS = 1000;
// Give up waiting for a job after this long so a stuck job can't hang forever.
const MAX_POLL_MS = 5 * 60 * 1000;

export interface SearchOptions {
  from?: string;
  to?: string;
  // Max rows to return (1–10000). Defaults to 100.
  limit?: number;
  // Search by message arrival (receipt) time rather than message timestamp.
  byReceiptTime?: boolean;
  // 'AutoParse' extracts JSON fields automatically; 'Manual' (default) does not.
  autoParsingMode?: 'AutoParse' | 'Manual';
}

// Only these fields can contain PII worth masking.
function sanitizeRow(row: any): any {
  if (row && row.map && typeof row.map === 'object') {
    const plainMap: Record<string, string> = {};
    Object.keys(row.map).forEach((key) => {
      const rawValue = row.map[key]?.toString() || '';
      if (key === '_raw' || key === 'response') {
        plainMap[key] = maskSensitiveInfo(rawValue);
      } else {
        plainMap[key] = rawValue;
      }
    });

    const maskedRaw = row._raw
      ? maskSensitiveInfo(row._raw.toString())
      : undefined;

    return { ...row, map: plainMap, _raw: maskedRaw };
  }

  if (row && row._raw && typeof row._raw === 'string') {
    return { ...row, _raw: maskSensitiveInfo(row._raw) };
  }

  if (row && row.response && typeof row.response === 'string') {
    return { ...row, response: maskSensitiveInfo(row.response) };
  }

  if (typeof row === 'string') {
    return row;
  }

  if (typeof row === 'object' && row !== null) {
    const result = { ...row };
    if (result._raw && typeof result._raw === 'string') {
      result._raw = maskSensitiveInfo(result._raw);
    }
    if (result.response && typeof result.response === 'string') {
      result.response = maskSensitiveInfo(result.response);
    }
    return result;
  }

  return row;
}

interface SumoAPIError {
  statusCode?: number;
  message: string;
  error?: any;
  response?: {
    body: any;
  };
}

export async function search(
  client: Sumo.Client,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const defaultTimeRange = {
    from: moment().subtract(1, 'day').toISOString(true).slice(0, 19),
    to: moment().toISOString(true).slice(0, 19),
  };

  const { from, to } = {
    ...defaultTimeRange,
    ...(options.from && { from: options.from }),
    ...(options.to && { to: options.to }),
  };

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_ROWS);

  // Create search job
  const jobParams: Sumo.IJobOptions = {
    query,
    from,
    to,
    timeZone: 'Asia/Hong_Kong',
    ...(options.byReceiptTime !== undefined && {
      byReceiptTime: options.byReceiptTime,
    }),
    ...(options.autoParsingMode && { autoParsingMode: options.autoParsingMode }),
  };

  try {
    const { id } = await client.job(jobParams);

    // Wait for the job to reach a terminal state. A job may also end in
    // CANCELLED, and 'FORCE PAUSED' means results are ready (a non-aggregate
    // query hit its 100K cap) — so treat both done states as complete. Guard
    // with a timeout so a stuck job can't spin this loop forever.
    const doneStates = ['DONE GATHERING RESULTS', 'FORCE PAUSED'];
    const startedAt = Date.now();
    let status;
    do {
      status = await client.status(id);

      if (status.state === 'CANCELLED') {
        await Promise.resolve(client.delete(id)).catch(() => undefined);
        throw new Error('Sumo Logic search job was cancelled');
      }

      if (doneStates.includes(status.state)) {
        break;
      }

      if (Date.now() - startedAt > MAX_POLL_MS) {
        await Promise.resolve(client.delete(id)).catch(() => undefined);
        throw new Error(
          `Sumo Logic search job did not complete within ${
            MAX_POLL_MS / 1000
          }s (last state: ${status.state})`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } while (true);

    // Aggregate queries (count/sum/avg/by/timeslice/...) produce records rather
    // than raw messages. Sumo Logic reports how many of each the job produced,
    // so use recordCount to decide which endpoint holds the actual results.
    const isAggregate = (status.recordCount ?? 0) > 0;

    if (isAggregate) {
      const records = await client.records(id, {
        offset: 0,
        limit: Math.min(status.recordCount, limit),
      });

      // Cleanup
      await client.delete(id);

      return {
        type: 'records',
        fields: records.fields,
        records: records.records.map(sanitizeRow),
      };
    }

    // Non-aggregate search: return the raw log messages.
    const messages = await client.messages(id, { offset: 0, limit });

    // Cleanup
    await client.delete(id);

    return {
      type: 'messages',
      fields: messages.fields,
      messages: messages.messages.map(sanitizeRow),
    };
  } catch (error) {
    console.error('Sumo Logic search error:', error);
    throw error;
  }
}

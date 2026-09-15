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
  timeRange?: { from?: string; to?: string },
): Promise<SearchResult> {
  const defaultTimeRange = {
    from: moment().subtract(1, 'day').toISOString(true).slice(0, 19),
    to: moment().toISOString(true).slice(0, 19),
  };

  const { from, to } = {
    ...defaultTimeRange,
    ...(timeRange?.from && { from: timeRange.from }),
    ...(timeRange?.to && { to: timeRange.to }),
  };

  // Create search job
  const jobParams = {
    query,
    from,
    to,
    timeZone: 'Asia/Hong_Kong',
  };

  try {
    const { id } = await client.job(jobParams);

    // Wait for job completion
    let status;
    do {
      try {
        status = await client.status(id);
        if (status.state !== 'DONE GATHERING RESULTS') {
          await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
        }
      } catch (statusError) {
        throw statusError;
      }
    } while (status.state !== 'DONE GATHERING RESULTS');

    // Aggregate queries (count/sum/avg/by/timeslice/...) produce records rather
    // than raw messages. Sumo Logic reports how many of each the job produced,
    // so use recordCount to decide which endpoint holds the actual results.
    const isAggregate = (status.recordCount ?? 0) > 0;

    if (isAggregate) {
      const limit = Math.min(status.recordCount, MAX_ROWS);
      const records = await client.records(id, { offset: 0, limit });

      // Cleanup
      await client.delete(id);

      return {
        type: 'records',
        fields: records.fields,
        records: records.records.map(sanitizeRow),
      };
    }

    // Non-aggregate search: return the raw log messages.
    const messages = await client.messages(id);

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

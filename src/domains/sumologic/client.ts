import moment from 'moment';
import * as Sumo from '@/lib/sumologic/client.js';
import { maskSensitiveInfo } from '@/utils/pii.js';

export interface SearchResult {
  messages: any[];
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

    // Get results
    const [messages] = await Promise.all([client.messages(id)]);

    // Cleanup
    await client.delete(id);

    // Ensure messages are properly formatted for JSON serialization and filter PII
    const sanitizedMessages = messages.messages.map((message: any) => {
      // Convert message.map to a plain object if it exists
      if (message.map && typeof message.map === 'object') {
        const plainMap: Record<string, string> = {};
        Object.keys(message.map).forEach((key) => {
          // Ensure values are strings and handle potential undefined values
          const rawValue = message.map[key]?.toString() || '';

          // Only apply PII masking to _raw and response fields
          if (key === '_raw' || key === 'response') {
            plainMap[key] = maskSensitiveInfo(rawValue);
          } else {
            plainMap[key] = rawValue;
          }
        });

        // Also mask the _raw property if it exists at the top level
        const maskedRaw = message._raw
          ? maskSensitiveInfo(message._raw.toString())
          : undefined;

        return {
          ...message,
          map: plainMap,
          _raw: maskedRaw,
        };
      }

      // If message has a _raw property (contains raw log text)
      if (message._raw && typeof message._raw === 'string') {
        return {
          ...message,
          _raw: maskSensitiveInfo(message._raw),
        };
      }

      // If message has a response property
      if (message.response && typeof message.response === 'string') {
        return {
          ...message,
          response: maskSensitiveInfo(message.response),
        };
      }

      // If message is a string, don't apply PII masking
      if (typeof message === 'string') {
        return message;
      }

      // If message is an object, only filter _raw and response fields
      if (typeof message === 'object' && message !== null) {
        const result = { ...message };

        if (result._raw && typeof result._raw === 'string') {
          result._raw = maskSensitiveInfo(result._raw);
        }

        if (result.response && typeof result.response === 'string') {
          result.response = maskSensitiveInfo(result.response);
        }

        return result;
      }

      // For other message formats, return as is
      return message;
    });

    return {
      messages: sanitizedMessages,
    };
  } catch (error) {
    console.error('Sumo Logic search error:', error);
    throw error;
  }
}

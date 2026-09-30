// Minimal in-memory stand-in for the Sumo Logic HTTP API, so the search
// orchestration can be exercised without credentials or network.
import { Client } from '@/lib/sumologic/client.js';

export interface FakeCall {
  verb: 'get' | 'post' | 'delete';
  url: string;
  body?: any;
}

type Route = (call: FakeCall) => any;

export function fakeClient(
  routes: Array<[RegExp, 'get' | 'post' | 'delete', Route]>,
) {
  const calls: FakeCall[] = [];
  const handle = (verb: FakeCall['verb']) => async (opts: any) => {
    const call = {
      verb,
      url: opts.url.replace('https://api.sumologic.com/api/v1', ''),
      body: opts.body,
    };
    calls.push(call);
    const route = routes.find(([re, v]) => v === verb && re.test(call.url));
    if (!route) {
      throw Object.assign(new Error(`no route for ${verb} ${call.url}`), {
        statusCode: 404,
      });
    }
    return route[2](call);
  };
  const http = {
    get: handle('get'),
    post: handle('post'),
    delete: handle('delete'),
  } as any;
  const client = new Client(http, {
    endpoint: 'https://api.sumologic.com/api/v1',
    sumoApiId: 'id',
    sumoApiKey: 'key',
  });
  return { client, calls };
}

export const done = (extra: Record<string, any> = {}) => ({
  state: 'DONE GATHERING RESULTS',
  messageCount: 0,
  recordCount: 0,
  histogramBuckets: [],
  pendingErrors: [],
  pendingWarnings: [],
  ...extra,
});

export const httpError = (statusCode: number, body: any = {}) =>
  Object.assign(new Error(`${statusCode} - ${JSON.stringify(body)}`), {
    statusCode,
    error: body,
    response: { statusCode, headers: {}, body },
  });

// Standard job lifecycle: POST job -> GET status -> GET messages/records -> DELETE.
export function jobRoutes(opts: {
  status: any | (() => any);
  messages?: any[];
  records?: any[] | ((jobBody: any) => any[]);
  onJob?: (body: any) => void;
}): Array<[RegExp, 'get' | 'post' | 'delete', Route]> {
  const jobs = new Map<string, any>();
  const jobOf = (url: string) => jobs.get(/JOB\d+/.exec(url)?.[0] ?? '');
  return [
    [
      /^\/search\/jobs$/,
      'post',
      ({ body }) => {
        opts.onJob?.(body);
        const id = `JOB${jobs.size + 1}`;
        jobs.set(id, body);
        return { id };
      },
    ],
    [
      /^\/search\/jobs\/JOB\d+\/messages/,
      'get',
      ({ url }) => {
        const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
        const limit = Number(/limit=(\d+)/.exec(url)?.[1] ?? 0);
        return {
          fields: [],
          messages: (opts.messages ?? []).slice(offset, offset + limit),
        };
      },
    ],
    [
      /^\/search\/jobs\/JOB\d+\/records/,
      'get',
      ({ url }) => ({
        fields: [{ name: '_count' }],
        records:
          typeof opts.records === 'function'
            ? opts.records(jobOf(url))
            : (opts.records ?? []),
      }),
    ],
    [
      /^\/search\/jobs\/JOB\d+$/,
      'get',
      () => (typeof opts.status === 'function' ? opts.status() : opts.status),
    ],
    [/^\/search\/jobs\/JOB\d+$/, 'delete', () => undefined],
  ];
}

import queryString from 'query-string';
import { mergeRight } from 'ramda';
import requestPromise from 'request-promise-native';
import type { CookieJar } from 'request';
import { RateLimiter } from '@/lib/sumologic/limiter.js';
import * as types from '@/lib/sumologic/types.js';

const defaultPaginationOptions: types.IPaginationOptions = {
  limit: 40,
  offset: 0,
};

// A socket that never answers would otherwise hang a tool call forever.
const REQUEST_TIMEOUT_MS = 120 * 1000;

export class Client {
  private httpClient: types.HttpClient;
  private params: types.IClientOptions;
  private jarFactory?: () => CookieJar;
  private jar?: CookieJar;

  constructor(
    httpClient: types.HttpClient,
    params: types.IClientOptions,
    jarFactory?: () => CookieJar,
  ) {
    this.httpClient = httpClient;
    this.params = params;
    this.jarFactory = jarFactory;
  }

  public get endpoint(): string {
    return this.params.endpoint;
  }

  // The Search Job API pins a job to the session cookie it was created with.
  // One shared cookie jar lets concurrent searches overwrite each other's
  // session, so each search gets its own jar via a scoped client.
  public withSession(): Client {
    if (!this.jarFactory) {
      return this;
    }
    const scoped = new Client(this.httpClient, this.params);
    scoped.jar = this.jarFactory();
    return scoped;
  }

  public job(params: types.IJobOptions): PromiseLike<types.IJob> {
    return this.httpClient.post(
      this.options({
        body: params,
        url: '/search/jobs',
      }),
    );
  }

  public status(id: string): PromiseLike<types.IStatus> {
    return this.httpClient.get(this.options({ url: `/search/jobs/${id}` }));
  }

  public messages(
    id: string,
    params: Partial<types.IPaginationOptions> = defaultPaginationOptions,
  ): PromiseLike<types.IMessages> {
    const query = this.paginationQuery(
      mergeRight(defaultPaginationOptions, params),
    );

    return this.httpClient.get(
      this.options({
        url: `/search/jobs/${id}/messages?${query}`,
      }),
    );
  }

  public records(
    id: string,
    params: Partial<types.IPaginationOptions> = defaultPaginationOptions,
  ): PromiseLike<types.IRecords> {
    const query = this.paginationQuery(
      mergeRight(defaultPaginationOptions, params),
    );

    return this.httpClient.get(
      this.options({
        url: `/search/jobs/${id}/records?${query}`,
      }),
    );
  }

  public delete(id: string): PromiseLike<void> {
    return this.httpClient.delete(this.options({ url: `/search/jobs/${id}` }));
  }

  // Generic read helpers for the management APIs (fields, partitions,
  // monitors, ...). `path` is relative to ENDPOINT, e.g. `/partitions`.
  public getJson<T = any>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): PromiseLike<T> {
    const qs = query ? queryString.stringify(query, { skipNull: true }) : '';
    return this.httpClient.get(
      this.options({ url: qs ? `${path}?${qs}` : path }),
    );
  }

  public postJson<T = any>(path: string, body: any): PromiseLike<T> {
    return this.httpClient.post(this.options({ url: path, body }));
  }

  private paginationQuery(params: types.IPaginationOptions): string {
    return queryString.stringify(params);
  }

  private options(options: types.IHttpCallOptions): types.HttpClientOptions {
    const defaultOptions = {
      auth: {
        pass: this.params.sumoApiKey,
        user: this.params.sumoApiId,
      },
      jar: this.jar ?? true,
      json: true,
      timeout: REQUEST_TIMEOUT_MS,
    };

    const endpoint = this.params.endpoint.endsWith('/')
      ? this.params.endpoint.slice(0, -1)
      : this.params.endpoint;
    const path = options.url?.startsWith('/') ? options.url : `/${options.url}`;

    const requestOptions = {
      ...options,
      url: endpoint + path,
    };

    return mergeRight(requestOptions, defaultOptions);
  }
}

// Route every HTTP verb through the shared limiter.
function limited(
  http: types.HttpClient,
  limiter: RateLimiter,
): types.HttpClient {
  const wrap = (verb: 'get' | 'post' | 'delete') => (opts: any) =>
    limiter.run(() => (http as any)[verb](opts));
  return {
    get: wrap('get'),
    post: wrap('post'),
    delete: wrap('delete'),
  } as unknown as types.HttpClient;
}

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const client = (params: types.IClientOptions): Client => {
  const limiter = new RateLimiter({
    maxPerSecond: envNumber('SUMO_MAX_REQUESTS_PER_SECOND', 4),
    maxInFlight: envNumber('SUMO_MAX_IN_FLIGHT', 10),
  });
  return new Client(limited(requestPromise, limiter), params, () =>
    requestPromise.jar(),
  );
};

export { client };
export * from './types.js';

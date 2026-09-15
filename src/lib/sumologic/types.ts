import type { RequestAPI, RequiredUriUrl, Options } from 'request';
import type {
  RequestPromise,
  RequestPromiseOptions,
} from 'request-promise-native';

export interface IJob {
  status: number;
  id: string;
  code: string;
  message: string;
}

export interface IHistogramBucket {
  length: number;
  count: number;
  startTimestamp: number;
}

// Neither structure is specified at
// https://help.sumologic.com/APIs/02Search_Job_API/About_the_Search_Job_API
export type Error = any;
export type Warning = any;

export interface IStatus {
  state: string;
  messageCount: number;
  histogramBuckets: IHistogramBucket[];
  pendingErrors: Error[];
  pendingWarnings: Warning[];
  recordCount: number;
}

export interface IField {
  name: string;
  fieldType: string;
  keyField: boolean;
}

export interface IMessage {
  map: { [key: string]: string };
}

export interface IMessages {
  fields: IField[];
  messages: IMessage[];
}

export interface IRecords {
  fields: IField[];
  records: IMessage[];
}

export type HttpClient = RequestAPI<
  RequestPromise,
  RequestPromiseOptions,
  RequiredUriUrl
>;

export interface IClientOptions {
  endpoint: string;
  sumoApiId: string;
  sumoApiKey: string;
}

export interface IJobOptions {
  query: string;
  from: string;
  to: string;
  timeZone: string;
  // Search by message arrival time instead of message timestamp.
  byReceiptTime?: boolean;
  // Search by indexed (searchable) time instead of message timestamp.
  bySearchableTime?: boolean;
  // 'AutoParse' enables dynamic JSON field extraction; 'Manual' (default) does not.
  autoParsingMode?: 'AutoParse' | 'Manual';
  // Keep raw messages for an aggregate query so /messages stays available.
  requiresRawMessages?: boolean;
}

export interface IHttpCallOptions {
  url?: string;
  body?: any;
}

export interface IPaginationOptions {
  offset: number;
  limit: number;
}

export type HttpClientOptions = Options;

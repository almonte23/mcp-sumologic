import { config } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { search } from '@/domains/sumologic/client.js';
import { formatToolError } from '@/domains/sumologic/errors.js';
import * as Sumo from '@/lib/sumologic/client.js';
import { SERVER_INSTRUCTIONS } from '@/instructions.js';
import { aroundParams, EXTRA_TOOLS, registerExtraTools } from '@/tools.js';
import { toJsonText } from '@/utils/json.js';

const VERSION = '1.6.3';
const ENABLED_TOOLS = ['search_sumologic', ...EXTRA_TOOLS];

// Load environment variables from .env file
config();

const sumoClient = Sumo.client({
  endpoint: process.env.ENDPOINT || '',
  sumoApiId: process.env.SUMO_API_ID || '',
  sumoApiKey: process.env.SUMO_API_KEY || '',
});

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'mcp-sumologic',
      version: VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.tool(
    'search_sumologic',
    'Run a Sumo Logic log search and return the results. ' +
      'Supports BOTH non-aggregate searches (raw log messages) and aggregate ' +
      'queries. Aggregate queries use operators such as `count`, `count_distinct`, ' +
      '`sum`, `avg`, `min`, `max`, `pct`, `by`, and `timeslice` ' +
      '(e.g. `_sourceCategory=prod/api | timeslice 1h | count by _timeslice`). ' +
      'The response includes a `type` field: "messages" for raw searches or ' +
      '"records" for aggregate results, with the rows under the matching key and ' +
      'column definitions under `fields`. Every response also carries `meta` ' +
      '(jobId, resolved window, totals vs returned, truncated, completeness, ' +
      'Sumo warnings/errors, UI link); check `meta.completeness` before ' +
      'concluding that an empty result means nothing happened.',
    {
      query: z
        .string()
        .describe(
          'Sumo Logic search query. Aggregate operators (count, sum, avg, by, ' +
            'timeslice, etc.) are fully supported and return aggregated records.',
        ),
      from: z
        .string()
        .optional()
        .describe(
          'Start of the time range as an ISO 8601 timestamp. Interpreted in ' +
            '`timeZone` (UTC by default) when it carries no offset. Also accepts ' +
            'epoch millis or a relative time such as "-15m", "-24h", "-60d". ' +
            'Defaults to 24 hours ago.',
        ),
      to: z
        .string()
        .optional()
        .describe(
          'End of the time range as an ISO 8601 timestamp. Interpreted in ' +
            '`timeZone` (UTC by default) when it carries no offset. Also accepts ' +
            'epoch millis, "now", or a relative time. Defaults to now.',
        ),
      ...aroundParams,
      timeZone: z
        .string()
        .optional()
        .describe(
          'IANA time zone (e.g. "UTC", "America/New_York") used to interpret ' +
            '`from`/`to` when they have no explicit offset. Defaults to UTC.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100000)
        .optional()
        .describe(
          'Maximum number of rows to return (1–100000). Defaults to 100. Rows ' +
            'beyond a single 10000 row page are fetched by paginating.',
        ),
      byReceiptTime: z
        .boolean()
        .optional()
        .describe(
          'Search by the time logs were received rather than their own timestamp. ' +
            'Useful for finding logs during ingestion delays.',
        ),
      bySearchableTime: z
        .boolean()
        .optional()
        .describe(
          'Search by indexed (searchable) time rather than the message timestamp.',
        ),
      autoParsingMode: z
        .enum(['AutoParse', 'Manual'])
        .optional()
        .describe(
          'Set to "AutoParse" to automatically extract fields from structured ' +
            '(JSON) logs. Defaults to "Manual" (no auto extraction).',
        ),
      requiresRawMessages: z
        .boolean()
        .optional()
        .describe(
          'For aggregate queries, also return the raw log messages behind the ' +
            'aggregation (under `messages`) instead of only the aggregated `records`.',
        ),
      includeHistogram: z
        .boolean()
        .optional()
        .describe(
          'Also return volume-over-time histogram buckets for the search under ' +
            '`histogram`.',
        ),
      allowLargeResult: z
        .boolean()
        .optional()
        .describe(
          'Return more than 2000 raw messages. Off by default because a very ' +
            'large raw payload can drop the connection; prefer an aggregate ' +
            'query for big result sets. Does not affect aggregate records.',
        ),
      returnFields: z
        .array(z.string())
        .optional()
        .describe(
          'Keep only these keys in each row `map` and in `fields` ' +
            '(case-insensitive) to shrink ' +
            'the payload, e.g. ["_messagetime", "_sourcecategory", "_raw"].',
        ),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({
      query,
      from,
      to,
      limit,
      byReceiptTime,
      bySearchableTime,
      autoParsingMode,
      requiresRawMessages,
      includeHistogram,
      allowLargeResult,
      timeZone,
      around,
      aroundMinutes,
      returnFields,
    }) => {
      try {
        const cleanedQuery = query.replace(/\n/g, '');
        const results = await search(sumoClient, cleanedQuery, {
          from,
          to,
          limit,
          byReceiptTime,
          bySearchableTime,
          autoParsingMode,
          requiresRawMessages,
          includeHistogram,
          allowLargeResult,
          timeZone,
          around,
          aroundMinutes,
          returnFields,
        });

        return {
          content: [
            {
              type: 'text',
              text: toJsonText(results),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: formatToolError(err),
            },
          ],
        };
      }
    },
  );

  registerExtraTools(server, sumoClient);

  return server;
}

async function runStdioServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runServer() {
  if (process.env.MCP_TRANSPORT === 'stdio') {
    await runStdioServer();
    return;
  }

  const app = express();
  app.use(express.json());

  // Map to store transports by session ID for stateful connections
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'mcp-sumologic',
      version: VERSION,
      enabled_tools: ENABLED_TOOLS,
    });
  });

  // Handle POST requests for client-to-server communication
  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
            console.log(`New MCP session initialized: ${newSessionId}`);
          },
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            console.log(`MCP session closed: ${transport.sessionId}`);
            delete transports[transport.sessionId];
          }
        };

        const server = createServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // Reusable handler for GET and DELETE requests
  const handleSessionRequest = async (
    req: express.Request,
    res: express.Response,
  ) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  // Handle GET requests for server-to-client notifications via SSE
  app.get('/mcp', handleSessionRequest);

  // Handle DELETE requests for session termination
  app.delete('/mcp', handleSessionRequest);

  const port = parseInt(process.env.PORT || '3006', 10);

  app.listen(port, '0.0.0.0', () => {
    console.log(`MCP Sumologic Server running on http://0.0.0.0:${port}`);
    console.log(`Health check available at http://0.0.0.0:${port}/health`);
    console.log(`MCP endpoint available at http://0.0.0.0:${port}/mcp`);
  });
}

runServer().catch((error) => {
  console.error('Failed to start Sumologic MCP server:', error);
  process.exit(1);
});

// stderr, because in stdio mode stdout carries only MCP protocol messages.
process.on('SIGINT', async () => {
  console.error('Shutting down Sumologic MCP server...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('Shutting down Sumologic MCP server...');
  process.exit(0);
});

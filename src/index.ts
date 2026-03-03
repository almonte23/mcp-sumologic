import { config } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { search } from '@/domains/sumologic/client.js';
import * as Sumo from '@/lib/sumologic/client.js';

// Load environment variables from .env file
config();

const sumoClient = Sumo.client({
  endpoint: process.env.ENDPOINT || '',
  sumoApiId: process.env.SUMO_API_ID || '',
  sumoApiKey: process.env.SUMO_API_KEY || '',
});

// Safely stringify objects, handling potential circular references
const safeStringify = (obj: any) => {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular Reference]';
        }
        seen.add(value);
      }
      return value;
    },
    2,
  );
};

function createServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-sumologic',
    version: '1.0.0',
  });

  server.tool(
    'search_sumologic',
    {
      query: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
    },
    async ({ query, from, to }) => {
      try {
        const cleanedQuery = query.replace(/\n/g, '');
        const results = await search(sumoClient, cleanedQuery, { from, to });

        return {
          content: [
            {
              type: 'text',
              text: safeStringify(results),
            },
          ],
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Unknown error');
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  return server;
}

async function runServer() {
  const app = express();
  app.use(express.json());

  // Map to store transports by session ID for stateful connections
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'mcp-sumologic',
      version: '1.0.0',
      enabled_tools: ['search_sumologic'],
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

process.on('SIGINT', async () => {
  console.log('Shutting down Sumologic MCP server...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down Sumologic MCP server...');
  process.exit(0);
});

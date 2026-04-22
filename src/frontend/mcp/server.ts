/**
 * mcpServer.ts
 *
 * Hosts a local HTTP server implementing the MCP protocol over Server-Sent Events (SSE).
 * Claude Code connects to http://localhost:<port>/sse to discover and call tools.
 *
 * Each GET /sse creates a new persistent SSE channel.
 * Claude Code POSTs tool calls to /message, and responses flow back over SSE.
 */

import * as http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerAllTools } from './tools/index';
import * as logger from './logger';

export class McpHttpServer {
    private httpServer: http.Server | undefined;
    private mcpServer: McpServer;
    private activePort: number | undefined;
    private transports: Map<string, SSEServerTransport> = new Map();

    constructor(private preferredPort: number) {
        this.mcpServer = new McpServer({
            name: 'cortex-debug-bridge',
            version: '0.1.0'
        });
        registerAllTools(this.mcpServer);
    }

    get port(): number | undefined {
        return this.activePort;
    }

    get running(): boolean {
        return !!this.httpServer;
    }

    async start(): Promise<number> {
        if (this.httpServer) {
            return this.activePort;
        }

        const port = await this.findFreePort(this.preferredPort);
        await this.listenOn(port);
        this.activePort = port;
        logger.info(`MCP server started on http://localhost:${port}`);
        return port;
    }

    stop(): void {
        if (!this.httpServer) return;
        this.httpServer.close();
        this.httpServer = undefined;
        this.activePort = undefined;
        this.transports.clear();
        logger.info('MCP server stopped.');
    }

    // ── HTTP request handler ──────────────────────────────────────────────────

    private async handleRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse
    ): Promise<void> {
    // CORS — Claude Code's built-in browser may need this
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = req.url ?? '';

        // Health-check — useful for Claude Code to verify the server is up
        if (url === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
            return;
        }

        // SSE endpoint — Claude Code connects here to open a persistent channel
        if (url === '/sse' && req.method === 'GET') {
            logger.debug('New SSE client connected');
            const transport = new SSEServerTransport('/message', res);
            const sessionId = transport.sessionId;

            this.transports.set(sessionId, transport);

            res.on('close', () => {
                logger.debug(`SSE client disconnected (session ${sessionId})`);
                this.transports.delete(sessionId);
            });

            await this.mcpServer.connect(transport);
            return;
        }

        // Message endpoint — Claude Code POSTs tool-call JSON-RPC here
        if (url.startsWith('/message') && req.method === 'POST') {
            // Extract session ID from query string: /message?sessionId=xxx
            const sessionId = new URL(url, `http://localhost`).searchParams.get('sessionId');
            if (!sessionId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing sessionId query parameter' }));
                return;
            }

            const transport = this.transports.get(sessionId);
            if (!transport) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `No active SSE session with id '${sessionId}'` }));
                return;
            }

            await transport.handlePostMessage(req, res);
            return;
        }

        res.writeHead(404);
        res.end();
    }

    // ── Port helpers ──────────────────────────────────────────────────────────

    private listenOn(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const srv = http.createServer((req, res) => {
                this.handleRequest(req, res).catch((err) => {
                    logger.error(`Unhandled error in HTTP handler: ${err}`);
                    if (!res.headersSent) {
                        res.writeHead(500);
                        res.end();
                    }
                });
            });

            srv.on('error', reject);
            srv.listen(port, '127.0.0.1', () => {
                this.httpServer = srv;
                resolve();
            });
        });
    }

    private findFreePort(start: number, attempts = 10): Promise<number> {
        return new Promise((resolve, reject) => {
            let tried = 0;
            const tryPort = (port: number) => {
                const srv = http.createServer();
                srv.listen(port, '127.0.0.1', () => {
                    srv.close(() => resolve(port));
                });
                srv.on('error', () => {
                    if (++tried >= attempts) {
                        reject(new Error(`Could not find a free port in range ${start}–${start + attempts - 1}`));
                    } else {
                        tryPort(port + 1);
                    }
                });
            };
            tryPort(start);
        });
    }
}

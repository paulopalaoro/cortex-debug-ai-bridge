import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dap from '../dapBridge';

export function registerSetBreakpoint(server: McpServer) {
    server.tool(
        'set_breakpoint',
        'Sets a source-level breakpoint at the specified file and line. Use absolute file paths. The breakpoint takes effect immediately if the session is active.',
        {
            file: z.string().min(1)
                .describe('Absolute path to the source file (e.g. "C:/project/src/main.cpp")'),
            line: z.number().int().min(1)
                .describe('Line number (1-based)')
        },
        async ({ file, line }) => {
            try {
                const result = await dap.setBreakpoint(file, line);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ file, line, result }, null, 2)
                    }]
                };
            } catch (e: unknown) {
                return {
                    content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
                    isError: true
                };
            }
        }
    );
}

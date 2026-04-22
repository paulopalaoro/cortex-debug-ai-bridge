import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dap from '../dapBridge';

export function registerGetCallStack(server: McpServer) {
    server.tool(
        'get_call_stack',
        'Returns the current call stack of the paused target. Each frame includes the function name, source file, and line number. Requires the target to be paused at a breakpoint.',
        {
            levels: z.number().int().min(1).max(100).optional()
                .describe('Maximum number of frames to return (default: 20)')
        },
        async ({ levels = 20 }) => {
            try {
                const stack = await dap.getCallStack(levels);
                const result = stack.map((f, i) => ({
                    index: i,
                    function: f.name,
                    file: f.source?.path ?? f.source?.name ?? 'unknown',
                    line: f.line,
                    column: f.column,
                    frameId: f.id
                }));
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
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

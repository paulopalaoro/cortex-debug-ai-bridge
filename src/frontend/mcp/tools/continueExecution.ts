import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as dap from '../dapBridge';

export function registerContinueExecution(server: McpServer) {
    server.tool(
        'continue_execution',
        'Resumes target execution after a breakpoint or pause. After calling this, the target runs freely until the next breakpoint. Variable/register reads will fail until the target is paused again.',
        {},
        async () => {
            try {
                await dap.continueExecution();
                return {
                    content: [{ type: 'text' as const, text: 'Target execution resumed.' }]
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

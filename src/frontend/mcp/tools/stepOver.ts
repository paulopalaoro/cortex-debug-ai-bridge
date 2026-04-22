import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dap from '../dapBridge';

export function registerStepOver(server: McpServer) {
    server.tool(
        'step',
        'Steps the target MCU execution by one source line. Supports step-over (next line), step-into (enter function call), and step-out (return from current function). Target must be paused.',
        {
            type: z.enum(['over', 'into', 'out']).optional()
                .describe('"over" = next line (default), "into" = enter function, "out" = return from function')
        },
        async ({ type = 'over' }) => {
            try {
                if (type === 'over') await dap.stepOver();
                else if (type === 'into') await dap.stepInto();
                else await dap.stepOut();
                return {
                    content: [{ type: 'text' as const, text: `Step ${type} executed.` }]
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

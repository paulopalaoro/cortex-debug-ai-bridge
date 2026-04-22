import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as dap from '../dapBridge';

export function registerPauseExecution(server: McpServer) {
    server.tool(
        'pause_execution',
        'Halts the target MCU execution (equivalent to pressing the Pause button in the debugger). After pausing you can read variables, registers, and memory.',
        {},
        async () => {
            try {
                await dap.pauseExecution();
                return {
                    content: [{ type: 'text' as const, text: 'Target paused. You can now read variables, registers, and memory.' }]
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

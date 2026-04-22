import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as dap from '../dapBridge';

export function registerGetRegisters(server: McpServer) {
    server.tool(
        'get_registers',
        'Returns the ARM core register values (r0-r12, SP, LR, PC, xPSR and others) of the paused target. Values are returned as hex strings. Requires Cortex-Debug and a paused target.',
        {},
        async () => {
            try {
                const regs = await dap.getRegisters();
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(regs, null, 2) }]
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

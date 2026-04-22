import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dap from '../dapBridge';

export function registerGdbCommand(server: McpServer) {
    server.tool(
        'gdb_command',
        'Sends a raw GDB command to the Cortex-Debug debug adapter. This is a power-user escape hatch for operations not covered by other tools. Examples: "info registers", "x/16xb &rxBuf", "watch pitch", "p/x *(uint32_t*)0x40021000". Dangerous commands (quit, kill, detach) are blocked.',
        {
            command: z.string().min(1)
                .describe('Raw GDB command string (not MI syntax — use plain GDB CLI commands)')
        },
        async ({ command }) => {
            try {
                const result = await dap.executeGdbCommand(command);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ command, result }, null, 2)
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

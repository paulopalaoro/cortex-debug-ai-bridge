import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dap from '../dapBridge';

export function registerGetMemory(server: McpServer) {
    server.tool(
        'get_memory',
        'Reads raw bytes from the target MCU memory at a given address. Useful for inspecting buffers, peripheral registers, or any memory region. Returns data as hex bytes. Requires a paused target.',
        {
            address: z.string()
                .describe('Start address as a hex string (e.g. "0x20000000") or decimal number string'),
            length: z.number().int().min(1).max(1024)
                .describe('Number of bytes to read (max 1024)')
        },
        async ({ address, length }) => {
            try {
                const result = await dap.readMemory(address, length);

                // Format as hex dump
                const lines: string[] = [];
                const addrNum = parseInt(address, 16) || parseInt(address, 10);
                for (let i = 0; i < result.bytes.length; i += 16) {
                    const chunk = result.bytes.slice(i, i + 16);
                    const addrHex = (addrNum + i).toString(16).padStart(8, '0').toUpperCase();
                    const hex = chunk.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
                    const ascii = chunk.map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
                    lines.push(`0x${addrHex}  ${hex.padEnd(48)}  ${ascii}`);
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: `Memory dump at ${address} (${length} bytes):\n\n` + lines.join('\n')
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

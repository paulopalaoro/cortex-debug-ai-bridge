import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as net from 'net';
import * as logger from '../logger';

/**
 * Writes memory via OpenOCD's telnet port while the target is running.
 * Does NOT require the target to be paused.
 *
 * OpenOCD commands used:
 *   mww <addr> <value>  — write 32-bit word
 *   mwh <addr> <value>  — write 16-bit halfword
 *   mwb <addr> <value>  — write 8-bit byte
 *
 * Useful for GPIO control:
 *   GPIOA BSRR (0x50000018) — set pin HIGH (bit N = PA(N))
 *   GPIOA BRR  (0x50000028) — set pin LOW  (bit N = PA(N))
 */
const OPENOCD_TELNET_PORT = 50002;

const SIZE_CMD: Record<string, string> = {
    word: 'mww',
    halfword: 'mwh',
    byte: 'mwb',
};

async function openocdWrite(
    address: string,
    value: string,
    size: 'word' | 'halfword' | 'byte'
): Promise<string> {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(OPENOCD_TELNET_PORT, 'localhost');
        let buf = '';
        let ready = false;
        let cmdSent = false;

        const timeout = setTimeout(() => {
            sock.destroy();
            reject(new Error('OpenOCD telnet timeout'));
        }, 3000);

        sock.on('connect', () => {
            logger.debug(`openocdWrite: connected to telnet port ${OPENOCD_TELNET_PORT}`);
        });

        sock.on('data', (data: Buffer) => {
            buf += data.toString('latin1');

            // First prompt: send the write command
            if (!ready && buf.includes('> ')) {
                ready = true;
                buf = '';
                const cmd = `${SIZE_CMD[size]} ${address} ${value}\n`;
                logger.debug(`openocdWrite: sending "${cmd.trim()}"`);
                sock.write(cmd);
                cmdSent = true;
                return;
            }

            // Second prompt: command has finished executing
            if (ready && cmdSent && buf.includes('> ')) {
                clearTimeout(timeout);
                const response = buf.slice(0, buf.lastIndexOf('>')).trim();

                sock.write('exit\n');
                sock.destroy();

                // OpenOCD prints an error message if the write failed (e.g. invalid address)
                if (response.toLowerCase().includes('error')
            || response.toLowerCase().includes('invalid')
            || response.toLowerCase().includes('failed')) {
                    reject(new Error(`OpenOCD write error: ${response}`));
                } else {
                    resolve(response || 'ok');
                }
            }
        });

        sock.on('error', (err: Error) => {
            clearTimeout(timeout);
            reject(new Error(`OpenOCD telnet error: ${err.message}`));
        });
    });
}

export function registerWriteMemory(server: McpServer) {
    server.tool(
        'write_memory',
        'Writes a value to a memory address on the STM32 via OpenOCD telnet — works while the target is RUNNING (no pause needed). '
    + 'Useful for controlling GPIO pins, peripheral registers, or any memory-mapped address. '
    + 'Examples: set PA2 HIGH → address="0x50000018" value="0x4" (GPIOA BSRR bit 2); '
    + 'set PA2 LOW → address="0x50000028" value="0x4" (GPIOA BRR bit 2). '
    + 'Requires an active Cortex-Debug/PlatformIO debug session with OpenOCD on port 50002.',
        {
            address: z.string()
                .describe('Target address in hex, e.g. "0x50000018". Must be aligned to the access size.'),
            value: z.string()
                .describe('Value to write in hex, e.g. "0x00000004" or "0x4". For GPIO: bit N controls pin N.'),
            size: z.enum(['word', 'halfword', 'byte']).default('word')
                .describe('Access size: word=32-bit (default), halfword=16-bit, byte=8-bit'),
        },
        async ({ address, value, size }) => {
            try {
                const response = await openocdWrite(address, value, size ?? 'word');
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            ok: true,
                            address,
                            value,
                            size: size ?? 'word',
                            openocd: response
                        }, null, 2)
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

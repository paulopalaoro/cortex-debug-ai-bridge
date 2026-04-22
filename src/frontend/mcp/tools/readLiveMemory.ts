import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as net from 'net';
import * as logger from '../logger';

/**
 * Reads memory via OpenOCD's telnet port while the target is running.
 * Does NOT require the target to be paused (unlike read-memory DAP request).
 *
 * PlatformIO/Cortex-Debug launches OpenOCD with:
 *   -c "gdb_port 50000" -c "tcl_port 50001" -c "telnet_port 50002"
 */
const OPENOCD_TELNET_PORT = 50002;

async function openocdMdw(address: string, wordCount: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(OPENOCD_TELNET_PORT, 'localhost');
        let buf = '';
        let ready = false;
        let resultWords: string[] = [];

        const timeout = setTimeout(() => {
            sock.destroy();
            reject(new Error('OpenOCD telnet timeout'));
        }, 3000);

        sock.on('connect', () => {
            logger.debug(`openocdMdw: connected to telnet port ${OPENOCD_TELNET_PORT}`);
        });

        sock.on('data', (data: Buffer) => {
            buf += data.toString('latin1');

            if (!ready && buf.includes('> ')) {
                ready = true;
                buf = '';
                const cmd = `mdw ${address} ${wordCount}\n`;
                logger.debug(`openocdMdw: sending "${cmd.trim()}"`);
                sock.write(cmd);
                return;
            }

            if (ready && buf.includes('> ')) {
                // Parse response: "0x20000214: aabbccdd 11223344 ...\r\n\r\n> "
                const m = buf.match(/0x[0-9a-f]+:\s+([\s\S]*?)(?:\r?\n)*\s*>/i);
                if (m) {
                    resultWords = m[1].trim().split(/\s+/);
                }
                clearTimeout(timeout);
                sock.write('exit\n');
                sock.destroy();
                resolve(resultWords);
            }
        });

        sock.on('error', (err: Error) => {
            clearTimeout(timeout);
            reject(new Error(`OpenOCD telnet error: ${err.message}`));
        });
    });
}

function wordToFloat(hex: string): number {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(parseInt(hex, 16), 0);
    return buf.readFloatLE(0);
}

function wordToU16Lo(hex: string): number {
    return parseInt(hex, 16) & 0xffff;
}

function wordToI16Hi(hex: string): number {
    const hi = (parseInt(hex, 16) >>> 16) & 0xffff;
    return hi >= 0x8000 ? hi - 0x10000 : hi;
}

function wordToU8(hex: string, byteIndex: number): number {
    return (parseInt(hex, 16) >>> (byteIndex * 8)) & 0xff;
}

export function registerReadLiveMemory(server: McpServer) {
    server.tool(
        'read_live_memory',
        'Reads raw memory from the STM32 via OpenOCD telnet port while the target is running — does NOT require pausing. '
    + 'Returns word values and optionally decodes them as floats/int16/uint16. '
    + 'Addresses must be word-aligned (multiple of 4). '
    + 'Requires an active Cortex-Debug/PlatformIO debug session with OpenOCD on telnet port 50002.',
        {
            address: z.string()
                .describe('Start address in hex, e.g. "0x20000214". Must be 4-byte aligned.'),
            wordCount: z.number().int().min(1).max(64).default(4)
                .describe('Number of 32-bit words to read (default: 4)'),
            decodeAs: z.array(
                z.object({
                    name: z.string().describe('Variable name'),
                    wordOffset: z.number().int().min(0).describe('Word offset from start address (0 = first word)'),
                    type: z.enum(['float', 'uint16_lo', 'uint16_hi', 'int16_lo', 'int16_hi', 'uint8', 'uint32', 'int32'])
                        .describe('How to decode the word. _lo/_hi = low/high 16 bits of the word. uint8 reads byte 0.')
                })
            ).optional()
                .describe('Optional list of variables to decode from the raw words')
        },
        async ({ address, wordCount, decodeAs }) => {
            try {
                const words = await openocdMdw(address, wordCount ?? 4);
                logger.debug(`read_live_memory: got ${words.length} words`);

                const base = parseInt(address, 16);
                const rawWords: Record<string, string> = {};
                words.forEach((w, i) => {
                    rawWords[`0x${(base + i * 4).toString(16).padStart(8, '0')}`] = `0x${w}`;
                });

                const decoded: Record<string, number | string> = {};
                if (decodeAs) {
                    for (const field of decodeAs) {
                        const w = words[field.wordOffset];
                        if (!w) {
                            decoded[field.name] = `error: offset ${field.wordOffset} out of range`;
                            continue;
                        }
                        switch (field.type) {
                            case 'float': decoded[field.name] = wordToFloat(w); break;
                            case 'uint16_lo': decoded[field.name] = wordToU16Lo(w); break;
                            case 'uint16_hi': decoded[field.name] = (parseInt(w, 16) >>> 16) & 0xffff; break;
                            case 'int16_lo': {
                                const v = wordToU16Lo(w);
                                decoded[field.name] = v >= 0x8000 ? v - 0x10000 : v;
                                break;
                            }
                            case 'int16_hi': decoded[field.name] = wordToI16Hi(w); break;
                            case 'uint8': decoded[field.name] = wordToU8(w, 0); break;
                            case 'uint32': decoded[field.name] = parseInt(w, 16) >>> 0; break;
                            case 'int32': {
                                const v = parseInt(w, 16);
                                decoded[field.name] = v >= 0x80000000 ? v - 0x100000000 : v;
                                break;
                            }
                        }
                    }
                }

                const output = {
                    address,
                    wordCount: words.length,
                    rawWords,
                    ...(Object.keys(decoded).length > 0 ? { decoded } : {})
                };

                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }]
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

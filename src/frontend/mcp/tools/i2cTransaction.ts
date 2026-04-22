import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getChip } from '../peripherals/chipMap';
import { i2cTransaction } from '../peripherals/stm32Init';

/**
 * Execute an I2C master transaction.
 * The I2C peripheral must already be initialized with init_peripheral type=i2c.
 *
 * Supports the common "write register address then read N bytes" pattern
 * used by MPU6050, BME280, LIS3DH, and most I2C sensors.
 */
export function registerI2cTransaction(server: McpServer) {
    server.tool(
        'i2c_transaction',
        'Executes an I2C master transaction: optional write phase followed by optional read phase. '
    + 'The I2C peripheral must be initialized first with init_peripheral type="i2c". '
    + 'Uses RELOAD mode for multi-byte reads to prevent overrun — no polling needed. '
    + '\n\nCommon patterns:'
    + '\n  Scan for device: write=[] readCount=0 — if no error, device responded to address'
    + '\n  Read register: write=[0x75] readCount=1 (e.g. MPU6050 WHO_AM_I → 0x68)'
    + '\n  Read 6 bytes (accel): write=[0x3B] readCount=6'
    + '\n  Write config: write=[0x6B, 0x00] readCount=0 (MPU6050 power on)'
    + '\n  Burst read 14 bytes (accel+gyro+temp): write=[0x3B] readCount=14'
    + '\n\nRequires OpenOCD telnet on port 50002.',
        {
            chip: z.string().default('stm32g0')
                .describe('Chip family: stm32g0, stm32f0, etc.'),
            peripheral: z.string().default('I2C1')
                .describe('I2C peripheral: "I2C1" or "I2C2"'),
            address: z.number().int().min(0).max(127)
                .describe('7-bit I2C device address. MPU6050=0x68, BME280=0x76, LIS3DH=0x18, OLED=0x3C'),
            write: z.array(z.number().int().min(0).max(255)).default([])
                .describe('Bytes to write (register address + optional data). Send [] for read-only.'),
            readCount: z.number().int().min(0).max(64).default(0)
                .describe('Number of bytes to read after the write phase. 0 = write only.'),
        },
        async ({ chip, peripheral, address, write, readCount }) => {
            try {
                const chipDef = getChip(chip);
                if (!chipDef) {
                    return { content: [{ type: 'text' as const, text: `Unknown chip: ${chip}` }], isError: true };
                }

                if ((write?.length ?? 0) === 0 && (readCount ?? 0) === 0) {
                    return { content: [{ type: 'text' as const, text: 'Error: must have at least one of write bytes or readCount > 0' }], isError: true };
                }

                const rxData = await i2cTransaction(
                    chipDef,
                    peripheral ?? 'I2C1',
                    address,
                    write ?? [],
                    readCount ?? 0
                );

                const result: Record<string, unknown> = {
                    ok: true,
                    chip,
                    peripheral: (peripheral ?? 'I2C1').toUpperCase(),
                    address: `0x${address.toString(16).padStart(2, '0')}`,
                };

                if ((write?.length ?? 0) > 0) {
                    result['written'] = (write ?? []).map((b) => `0x${b.toString(16).padStart(2, '0')}`);
                }

                if ((readCount ?? 0) > 0) {
                    result['read_hex'] = rxData.map((b) => `0x${b.toString(16).padStart(2, '0')}`);
                    result['read_dec'] = rxData;

                    // Check for NACK pattern (all 0xFF usually indicates bus error or missing device)
                    if (rxData.every((b) => b === 0xFF)) {
                        result['warning'] = 'All received bytes are 0xFF — device may not have responded (NACK). '
              + 'Verify: 1) device address, 2) I2C pins and pull-ups, 3) I2C init was called first.';
                    }
                }

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

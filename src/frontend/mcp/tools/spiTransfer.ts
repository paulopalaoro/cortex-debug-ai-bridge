import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getChip } from '../peripherals/chipMap';
import { spiTransferBytes } from '../peripherals/stm32Init';

/**
 * Execute a SPI master transaction — send bytes, receive bytes.
 * The SPI peripheral must already be initialized with init_peripheral type=spi.
 *
 * Works for any SPI slave: CC1101 RF, MPU9250, flash chips, displays, etc.
 * CS pin is asserted (LOW) before the transfer and deasserted (HIGH) after.
 */
export function registerSpiTransfer(server: McpServer) {
    server.tool(
        'spi_transfer',
        'Executes a full SPI transaction: asserts CS, sends N bytes, receives N bytes, deasserts CS. '
    + 'The SPI peripheral must be initialized first with init_peripheral type="spi". '
    + 'TX and RX happen simultaneously — the returned bytes are what the slave sent back. '
    + '\n\nExamples:'
    + '\n  CC1101 read version register: data=[0xF1, 0x00] → should return [xx, 0x14]'
    + '\n  CC1101 read PARTNUM: data=[0x70, 0x00] → byte 0=status, byte 1=chip part number'
    + '\n  MPU6050 WHO_AM_I: data=[0xF5, 0x00] → byte 1 should be 0x68 or 0x72'
    + '\n  Flash JEDEC ID: data=[0x9F, 0x00, 0x00, 0x00] → manufacturer + device ID'
    + '\nRequires OpenOCD telnet on port 50002.',
        {
            chip: z.string().default('stm32g0')
                .describe('Chip family: stm32g0, stm32f0, etc.'),
            peripheral: z.string().default('SPI1')
                .describe('SPI peripheral name: "SPI1" or "SPI2"'),
            cs: z.string().optional()
                .describe('CS GPIO pin to assert during transfer, e.g. "PA15". If omitted, CS is not toggled.'),
            data: z.array(z.number().int().min(0).max(255))
                .describe('Array of bytes to transmit. The received bytes are returned in order. '
                  + 'Send 0x00 as filler bytes for read-only operations.'),
        },
        async ({ chip, peripheral, cs, data }) => {
            try {
                if (!data || data.length === 0) {
                    return { content: [{ type: 'text' as const, text: 'Error: data array must not be empty' }], isError: true };
                }

                const chipDef = getChip(chip);
                if (!chipDef) {
                    return { content: [{ type: 'text' as const, text: `Unknown chip: ${chip}` }], isError: true };
                }

                const rxData = await spiTransferBytes(chipDef, peripheral ?? 'SPI1', cs ?? null, data);

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            ok: true,
                            chip,
                            peripheral: (peripheral ?? 'SPI1').toUpperCase(),
                            cs: cs ?? null,
                            tx: data.map((b) => `0x${b.toString(16).padStart(2, '0')}`),
                            rx: rxData.map((b) => `0x${b.toString(16).padStart(2, '0')}`),
                            rx_dec: rxData,
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

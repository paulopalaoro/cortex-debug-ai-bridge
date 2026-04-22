import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mww, mdwOne } from '../peripherals/openocdLow';
import { getChip, gpioBase, GPIO, SPI_REG, I2C_REG, TIM_REG, CAN_REG, RTC_REG, USART_REG } from '../peripherals/chipMap';

/**
 * Write or modify a STM32 peripheral register by symbolic name.
 * Supports full-word write, bit-set/clear via mask, and read-modify-write.
 */

const REG_MAPS: Record<string, Record<string, number>> = {
    GPIO: GPIO,
    SPI: SPI_REG,
    I2C: I2C_REG,
    TIM: TIM_REG,
    CAN: CAN_REG,
    RTC: RTC_REG,
    USART: USART_REG,
    UART: USART_REG,
};

function getRegOffset(peripheral: string, register: string): number | null {
    const prefix = peripheral.replace(/\d+$/, '').toUpperCase();
    const map = REG_MAPS[prefix] ?? REG_MAPS[peripheral.toUpperCase()];
    if (!map) return null;
    return map[register.toUpperCase()] ?? null;
}

export function registerWriteRegister(server: McpServer) {
    server.tool(
        'write_register',
        'Writes a value to a STM32 peripheral register by name. '
    + 'Supports full-word write or read-modify-write (setMask/clearMask). '
    + 'Examples: '
    + 'peripheral="GPIOA" register="BSRR" value="0x4" sets PA2 HIGH; '
    + 'peripheral="GPIOA" register="BRR" value="0x4" sets PA2 LOW; '
    + 'peripheral="SPI1" register="CR1" value="0x364" initializes SPI; '
    + 'setMask="0x40" clearMask="0x0" sets only the SPE bit without changing others. '
    + 'Works while target is RUNNING — no pause needed.',
        {
            chip: z.string()
                .describe('Chip family: stm32g0, stm32f0, etc.'),
            peripheral: z.string()
                .describe('Peripheral: GPIOA, GPIOB, SPI1, I2C1, TIM1, etc.'),
            register: z.string()
                .describe('Register name: MODER, BSRR, BRR, IDR, ODR, CR1, CR2, SR, DR, TIMINGR, PSC, ARR, CCR1, etc.'),
            value: z.string().optional()
                .describe('Value to write in hex (full 32-bit write). Ignored if setMask/clearMask is used.'),
            setMask: z.string().optional()
                .describe('Bitmask of bits to SET (read-modify-write). E.g. "0x40" to set bit 6.'),
            clearMask: z.string().optional()
                .describe('Bitmask of bits to CLEAR (read-modify-write). E.g. "0x40" to clear bit 6.'),
        },
        async ({ chip, peripheral, register, value, setMask, clearMask }) => {
            try {
                const chipDef = getChip(chip);
                if (!chipDef) {
                    return { content: [{ type: 'text' as const, text: `Unknown chip: ${chip}` }], isError: true };
                }

                const periph = peripheral.toUpperCase();
                let base: number | null = null;
                const gpioMatch = periph.match(/^GPIO([A-F])$/);
                if (gpioMatch) {
                    base = gpioBase(chipDef, gpioMatch[1]);
                } else {
                    base = chipDef.peripherals[periph] ?? null;
                }

                if (base === null) {
                    return { content: [{ type: 'text' as const, text: `Unknown peripheral: ${peripheral}` }], isError: true };
                }

                const offset = getRegOffset(periph, register);
                if (offset === null) {
                    return { content: [{ type: 'text' as const, text: `Unknown register: ${register}` }], isError: true };
                }

                const addr = base + offset;
                let newValue: number;
                const prevValue = await mdwOne(addr);

                if (setMask !== undefined || clearMask !== undefined) {
                    const set = setMask ? parseInt(setMask, 16) : 0;
                    const clear = clearMask ? parseInt(clearMask, 16) : 0;
                    newValue = (prevValue | set) & ~clear;
                    await mww(addr, newValue);
                } else if (value !== undefined) {
                    newValue = parseInt(value, 16);
                    await mww(addr, newValue);
                } else {
                    return { content: [{ type: 'text' as const, text: 'Provide either value or setMask/clearMask' }], isError: true };
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            ok: true,
                            chip,
                            peripheral: periph,
                            register: register.toUpperCase(),
                            address: `0x${addr.toString(16).padStart(8, '0')}`,
                            prev: `0x${prevValue.toString(16).padStart(8, '0')}`,
                            written: `0x${(newValue >>> 0).toString(16).padStart(8, '0')}`,
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

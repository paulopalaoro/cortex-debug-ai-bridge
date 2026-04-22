import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mdwOne, mdw } from '../peripherals/openocdLow';
import { getChip, gpioBase, GPIO, SPI_REG, I2C_REG, TIM_REG } from '../peripherals/chipMap';

/**
 * Read one or more STM32 peripheral registers by symbolic name.
 * Examples:
 *   read_register chip=stm32g0 peripheral=GPIOA register=IDR
 *   read_register chip=stm32g0 peripheral=SPI1 register=SR
 *   read_register chip=stm32g0 peripheral=I2C1 register=ISR
 *   read_register chip=stm32g0 peripheral=TIM1 register=CNT
 */

// Symbolic register maps (offset from peripheral base)
const REG_MAPS: Record<string, Record<string, number>> = {
    GPIO: GPIO,
    SPI: SPI_REG,
    I2C: I2C_REG,
    TIM: TIM_REG,
};

function getRegOffset(peripheral: string, register: string): number | null {
    const prefix = peripheral.replace(/\d+$/, '').toUpperCase();
    const map = REG_MAPS[prefix] ?? REG_MAPS[peripheral.toUpperCase()];
    if (!map) return null;
    return map[register.toUpperCase()] ?? null;
}

export function registerReadRegister(server: McpServer) {
    server.tool(
        'read_register',
        'Reads a STM32 peripheral register by name while the target is running. '
    + 'Supports GPIO, SPI, I2C, TIM peripherals by symbolic name. '
    + 'Examples: peripheral="GPIOA" register="IDR" reads all pin inputs; '
    + 'peripheral="SPI1" register="SR" reads the SPI status register; '
    + 'peripheral="I2C1" register="ISR" reads I2C status. '
    + 'For raw address access, use read_live_memory instead. '
    + 'Requires chip family to locate peripheral base address.',
        {
            chip: z.string()
                .describe('Chip family: stm32g0, stm32f0, etc. Use get_chip_info to detect automatically.'),
            peripheral: z.string()
                .describe('Peripheral name: GPIOA, GPIOB, SPI1, I2C1, TIM1, TIM3, etc.'),
            register: z.string()
                .describe('Register name: for GPIO: MODER/OTYPER/OSPEEDR/PUPDR/IDR/ODR/BSRR/AFRL/AFRH/BRR; '
                  + 'for SPI: CR1/CR2/SR/DR; for I2C: CR1/CR2/TIMINGR/ISR/ICR/RXDR/TXDR; '
                  + 'for TIM: CR1/CR2/CCMR1/CCMR2/CCER/PSC/ARR/CCR1/CCR2/CCR3/CCR4/BDTR'),
            wordCount: z.number().int().min(1).max(32).default(1)
                .describe('Number of consecutive 32-bit words to read (default: 1)'),
        },
        async ({ chip, peripheral, register, wordCount }) => {
            try {
                const chipDef = getChip(chip);
                if (!chipDef) {
                    return { content: [{ type: 'text' as const, text: `Unknown chip: ${chip}. Known chips: stm32g0, stm32f0` }], isError: true };
                }

                // Resolve peripheral base address
                let base: number | null = null;
                const periph = peripheral.toUpperCase();

                // Check if it's a GPIO peripheral
                const gpioMatch = periph.match(/^GPIO([A-F])$/);
                if (gpioMatch) {
                    base = gpioBase(chipDef, gpioMatch[1]);
                } else {
                    base = chipDef.peripherals[periph] ?? null;
                }

                if (base === null) {
                    return {
                        content: [{ type: 'text' as const, text: `Unknown peripheral "${peripheral}" for ${chip}. Available: ${Object.keys(chipDef.peripherals).join(', ')}` }],
                        isError: true
                    };
                }

                // Resolve register offset
                const offset = getRegOffset(periph, register);
                if (offset === null) {
                    return {
                        content: [{ type: 'text' as const, text: `Unknown register "${register}" for ${periph}. Check the register name spelling.` }],
                        isError: true
                    };
                }

                const addr = base + offset;
                const words = await mdw(addr, wordCount ?? 1);

                const result: Record<string, unknown> = {
                    chip,
                    peripheral: periph,
                    register: register.toUpperCase(),
                    address: `0x${addr.toString(16).padStart(8, '0')}`,
                };

                if ((wordCount ?? 1) === 1 && words.length > 0) {
                    const val = parseInt(words[0], 16);
                    result['value_hex'] = `0x${val.toString(16).padStart(8, '0')}`;
                    result['value_dec'] = val >>> 0;
                    result['value_bin'] = `0b${(val >>> 0).toString(2).padStart(32, '0')}`;
                    // Add per-bit breakdown
                    const bits: Record<string, number> = {};
                    for (let i = 0; i < 32; i++) {
                        bits[`bit${i}`] = (val >>> i) & 1;
                    }
                    result['bits'] = bits;
                } else {
                    result['words'] = words.map((w, i) => ({
                        address: `0x${(addr + i * 4).toString(16).padStart(8, '0')}`,
                        value: `0x${w}`,
                    }));
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

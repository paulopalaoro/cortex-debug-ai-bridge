import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getChip } from '../peripherals/chipMap';
import {
    configPin,
    initSpi,
    initI2c,
    initPwm,
    setPwmDuty,
    setGpioOutput,
    GpioMode, GpioPull, GpioSpeed, GpioOType,
} from '../peripherals/stm32Init';

/**
 * Initialize STM32 peripherals by register writes via OpenOCD telnet.
 * No firmware flashing needed — configures clocks, GPIO alt functions, and
 * peripheral registers directly on the running (or attached) MCU.
 */
export function registerInitPeripheral(server: McpServer) {
    server.tool(
        'init_peripheral',
        'Initializes a STM32 peripheral entirely through register writes via OpenOCD — '
    + 'no firmware needed. Supports GPIO (input/output/AF), SPI master, I2C master, and PWM. '
    + 'After init, use spi_transfer or i2c_transaction to communicate with devices. '
    + '\n\nExamples:'
    + '\n  GPIO output: type="gpio" chip="stm32g0" pin="PA2" mode="output"'
    + '\n  GPIO set HIGH: type="gpio" chip="stm32g0" pin="PA2" mode="output" value=true'
    + '\n  SPI master: type="spi" chip="stm32g0" peripheral="SPI1" sck="PB3" miso="PB4" mosi="PB5" cs="PA15"'
    + '\n  I2C master: type="i2c" chip="stm32g0" peripheral="I2C1" scl="PB6" sda="PB7"'
    + '\n  PWM output: type="pwm" chip="stm32g0" timer="TIM1" channel=1 pin="PA8" frequency=1000 duty=50'
    + '\n\nRequires OpenOCD telnet on port 50002.',
        {
            type: z.enum(['gpio', 'spi', 'i2c', 'pwm'])
                .describe('Peripheral type to initialize'),
            chip: z.string().default('stm32g0')
                .describe('Chip family: stm32g0 (G030/G071), stm32f0 (F042/F072). Use get_chip_info to detect.'),

            // ── GPIO params
            pin: z.string().optional()
                .describe('[GPIO] Pin name, e.g. "PA2", "PB5"'),
            mode: z.enum(['input', 'output', 'af', 'analog']).optional()
                .describe('[GPIO] Pin mode: input, output, af (alternate function), analog'),
            pull: z.enum(['none', 'up', 'down']).optional().default('none')
                .describe('[GPIO] Pull resistor: none, up, down (default: none)'),
            speed: z.enum(['low', 'medium', 'high', 'very-high']).optional().default('medium')
                .describe('[GPIO] Output speed: low, medium (default), high, very-high'),
            otype: z.enum(['push-pull', 'open-drain']).optional().default('push-pull')
                .describe('[GPIO] Output type: push-pull (default), open-drain'),
            af: z.number().int().min(0).max(15).optional().default(0)
                .describe('[GPIO] Alternate function number 0–15 (only for mode="af")'),
            value: z.boolean().optional()
                .describe('[GPIO] Initial output state: true=HIGH, false=LOW (optional, only for output mode)'),

            // ── SPI params
            peripheral: z.string().optional()
                .describe('[SPI/I2C] Peripheral instance: "SPI1", "SPI2", "I2C1", "I2C2"'),
            sck: z.string().optional()
                .describe('[SPI] SCK pin, e.g. "PB3"'),
            miso: z.string().optional()
                .describe('[SPI] MISO pin, e.g. "PB4"'),
            mosi: z.string().optional()
                .describe('[SPI] MOSI pin, e.g. "PB5"'),
            cs: z.string().optional()
                .describe('[SPI] Chip select pin as GPIO output (optional), e.g. "PA15"'),
            spiSpeed: z.number().optional().default(4_000_000)
                .describe('[SPI] Clock frequency in Hz (default: 4MHz). Rounded down to nearest ÷2^N.'),
            spiMode: z.number().int().min(0).max(3).optional().default(0)
                .describe('[SPI] SPI mode 0–3 (CPOL/CPHA): 0=idle-low/sample-rising (default), 3=idle-high/sample-falling'),

            // ── I2C params
            scl: z.string().optional()
                .describe('[I2C] SCL pin, e.g. "PB6"'),
            sda: z.string().optional()
                .describe('[I2C] SDA pin, e.g. "PB7"'),
            i2cSpeed: z.number().optional().default(100_000)
                .describe('[I2C] Bus speed in Hz: 100000 (standard, default) or 400000 (fast mode)'),
            timingrOverride: z.string().optional()
                .describe('[I2C] Optional TIMINGR hex value to override built-in timing calculation, e.g. "0xF0420F13"'),

            // ── PWM params
            timer: z.string().optional()
                .describe('[PWM] Timer name: TIM1, TIM3, TIM14, TIM15, TIM16, TIM17'),
            channel: z.number().int().min(1).max(4).optional().default(1)
                .describe('[PWM] Timer channel 1–4 (default: 1)'),
            frequency: z.number().optional().default(1000)
                .describe('[PWM] PWM frequency in Hz (default: 1000)'),
            duty: z.number().min(0).max(100).optional().default(50)
                .describe('[PWM] Duty cycle 0–100% (default: 50)'),
        },
        async ({
            type, chip,
            pin, mode, pull, speed, otype, af, value,
            peripheral, sck, miso, mosi, cs, spiSpeed, spiMode,
            scl, sda, i2cSpeed, timingrOverride,
            timer, channel, frequency, duty,
        }) => {
            try {
                const chipDef = getChip(chip);
                if (!chipDef) {
                    return {
                        content: [{ type: 'text' as const, text: `Unknown chip: "${chip}". Use get_chip_info to detect, or specify: stm32g0 (G030/G071), stm32f0 (F042/F072)` }],
                        isError: true
                    };
                }

                let result: Record<string, unknown> = { ok: true, chip, type };

                switch (type) {
                    case 'gpio': {
                        if (!pin) return err('pin is required for GPIO');
                        const gmode = (mode ?? 'output') as GpioMode;
                        const gpull = (pull ?? 'none') as GpioPull;
                        const gspeed = (speed ?? 'medium') as GpioSpeed;
                        const gotype = (otype ?? 'push-pull') as GpioOType;

                        if (value !== undefined && gmode === 'output') {
                            // Convenience: configure and set in one call
                            await setGpioOutput(chipDef, pin, value);
                            result = { ok: true, chip, type, pin, mode: gmode, value };
                        } else {
                            const { port, pin: pinNum } = requirePin(pin);
                            await configPin(chipDef, port, pinNum, gmode, gpull, gspeed, gotype, af ?? 0);
                            result = { ok: true, chip, type, pin, mode: gmode, pull: gpull, speed: gspeed, otype: gotype, af: gmode === 'af' ? af : undefined };
                        }
                        break;
                    }

                    case 'spi': {
                        if (!peripheral) return err('peripheral is required for SPI (e.g. "SPI1")');
                        if (!sck) return err('sck pin is required');
                        if (!miso) return err('miso pin is required');
                        if (!mosi) return err('mosi pin is required');

                        await initSpi(chipDef, peripheral, {
                            sck, miso, mosi, cs,
                            speedHz: spiSpeed ?? 4_000_000,
                            mode: (spiMode ?? 0) as 0 | 1 | 2 | 3,
                        });

                        result = {
                            ok: true, chip, type,
                            peripheral: peripheral.toUpperCase(),
                            sck, miso, mosi, cs: cs ?? null,
                            speedHz: spiSpeed,
                            spiMode,
                            note: cs
                                ? `CS pin ${cs} configured as GPIO output (active-low). Call spi_transfer to send bytes.`
                                : 'No CS pin configured. Toggle CS manually with init_peripheral type=gpio or write_memory.',
                        };
                        break;
                    }

                    case 'i2c': {
                        if (!peripheral) return err('peripheral is required for I2C (e.g. "I2C1")');
                        if (!scl) return err('scl pin is required');
                        if (!sda) return err('sda pin is required');

                        await initI2c(chipDef, peripheral, {
                            scl, sda,
                            speedHz: (i2cSpeed ?? 100_000) as 100_000 | 400_000,
                            timingrOverride: timingrOverride ? parseInt(timingrOverride, 16) : undefined,
                        });

                        result = {
                            ok: true, chip, type,
                            peripheral: peripheral.toUpperCase(),
                            scl, sda,
                            speedHz: i2cSpeed,
                            note: 'I2C initialized. Use i2c_transaction to communicate with devices.',
                        };
                        break;
                    }

                    case 'pwm': {
                        if (!timer) return err('timer is required for PWM (e.g. "TIM1")');
                        if (!pin) return err('pin is required for PWM (e.g. "PA8")');

                        await initPwm(chipDef, timer, {
                            pin,
                            channel: (channel ?? 1) as 1 | 2 | 3 | 4,
                            frequencyHz: frequency ?? 1000,
                            dutyPercent: duty ?? 50,
                        });

                        result = {
                            ok: true, chip, type,
                            timer: timer.toUpperCase(),
                            channel,
                            pin,
                            frequency,
                            duty,
                            note: 'PWM running. Use init_peripheral type=pwm again with same timer/channel to change duty cycle.',
                        };
                        break;
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

    // Also register a shorthand for updating PWM duty only
    server.tool(
        'set_pwm_duty',
        'Updates the PWM duty cycle on a running timer channel without re-initializing. '
    + 'The timer must have been initialized with init_peripheral type=pwm first.',
        {
            chip: z.string().default('stm32g0').describe('Chip family'),
            timer: z.string().describe('Timer name, e.g. "TIM1"'),
            channel: z.number().int().min(1).max(4).default(1).describe('Timer channel 1–4'),
            duty: z.number().min(0).max(100).describe('New duty cycle 0–100%'),
        },
        async ({ chip, timer, channel, duty }) => {
            try {
                const chipDef = getChip(chip);
                if (!chipDef) return { content: [{ type: 'text' as const, text: `Unknown chip: ${chip}` }], isError: true };
                await setPwmDuty(chipDef, timer, (channel ?? 1) as 1 | 2 | 3 | 4, duty);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, timer, channel, duty }, null, 2) }]
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

function err(msg: string) {
    return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true as const
    };
}

function requirePin(pinStr: string): { port: string; pin: number } {
    const m = pinStr.trim().match(/^P([A-Fa-f])(\d{1,2})$/);
    if (!m) throw new Error(`Invalid pin: ${pinStr}`);
    return { port: m[1].toUpperCase(), pin: parseInt(m[2]) };
}

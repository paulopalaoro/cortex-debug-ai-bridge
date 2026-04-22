/**
 * STM32 peripheral initialization via OpenOCD telnet register writes.
 * Works without any firmware on the chip — configures clocks, GPIO, SPI, I2C, PWM
 * entirely through memory-mapped register access.
 *
 * All functions require an active OpenOCD session (debug or just attach).
 */

import {
    mww, mdwOne, setBits,
    openocdBatch,
} from './openocdLow';
import {
    ChipDef, GPIO, GPIO_F1, SPI_REG, I2C_REG, I2C_REG_LEGACY, TIM_REG,
    parsePin, lookupAF, gpioBase as gpioBaseAddr,
} from './chipMap';
import * as logger from '../logger';

// ─── GPIO ────────────────────────────────────────────────────────────────────

/** Enable the clock for a GPIO port via RCC. */
export async function enableGpioClock(chip: ChipDef, port: string): Promise<void> {
    const bit = chip.rcc.gpioEnBit[port.toUpperCase()];
    if (bit === undefined) throw new Error(`Unknown GPIO port: ${port}`);
    await setBits(chip.rcc.gpioEnReg, 1 << bit, 1 << bit);
    logger.debug(`enableGpioClock: GPIO${port} clock enabled`);
}

/** Enable the clock for a named peripheral (e.g. 'SPI1', 'I2C1', 'TIM1'). */
export async function enablePeriphClock(chip: ChipDef, periph: string): Promise<void> {
    const p = periph.toUpperCase();
    const apb1bit = chip.rcc.apb1EnBit[p];
    const apb2bit = chip.rcc.apb2EnBit[p];
    if (apb1bit !== undefined) {
        await setBits(chip.rcc.apb1EnReg, 1 << apb1bit, 1 << apb1bit);
        logger.debug(`enablePeriphClock: ${p} APB1 clock enabled`);
    } else if (apb2bit !== undefined) {
        await setBits(chip.rcc.apb2EnReg, 1 << apb2bit, 1 << apb2bit);
        logger.debug(`enablePeriphClock: ${p} APB2 clock enabled`);
    } else {
        throw new Error(`Unknown peripheral: ${periph}`);
    }
}

export type GpioMode = 'input' | 'output' | 'af' | 'analog';
export type GpioPull = 'none' | 'up' | 'down';
export type GpioSpeed = 'low' | 'medium' | 'high' | 'very-high';
export type GpioOType = 'push-pull' | 'open-drain';

const MODE_BITS: Record<GpioMode, number> = { input: 0, output: 1, af: 2, analog: 3 };
const PULL_BITS: Record<GpioPull, number> = { none: 0, up: 1, down: 2 };
const SPEED_BITS: Record<GpioSpeed, number> = { low: 0, medium: 1, high: 2, 'very-high': 3 };

/**
 * Configure a single GPIO pin.
 * Dispatches to F1-specific CRL/CRH logic or the modern MODER/AFR approach.
 * Enables the port clock automatically.
 */
export async function configPin(
    chip: ChipDef,
    port: string,
    pin: number,
    mode: GpioMode,
    pull: GpioPull = 'none',
    speed: GpioSpeed = 'medium',
    otype: GpioOType = 'push-pull',
    af = 0
): Promise<void> {
    await enableGpioClock(chip, port);
    if (chip.gpioModel === 'f1') {
        await configPinF1(chip, port, pin, mode, pull, speed, otype);
        return;
    }
    const base = gpioBaseAddr(chip, port);
    if (base === null) throw new Error(`Unknown GPIO port: ${port}`);

    const modeMask = 0x3 << (pin * 2);
    const pullMask = 0x3 << (pin * 2);
    const speedMask = 0x3 << (pin * 2);
    const otypeMask = 0x1 << pin;

    // Always reset AFR for this pin so old alternate-function config from firmware
    // (e.g. pin was USART/SPI/CAN) doesn't leak through when we reconfigure as plain I/O.
    // If mode is 'af', we override AFR below with the requested value.
    const afReg = pin < 8 ? base + GPIO.AFRL : base + GPIO.AFRH;
    const afBit = (pin < 8 ? pin : pin - 8) * 4;
    const afVal = mode === 'af' ? af : 0;
    await setBits(afReg, 0xF << afBit, afVal << afBit);

    await setBits(base + GPIO.MODER, modeMask, MODE_BITS[mode] << (pin * 2));
    await setBits(base + GPIO.OTYPER, otypeMask, (otype === 'open-drain' ? 1 : 0) << pin);
    await setBits(base + GPIO.OSPEEDR, speedMask, SPEED_BITS[speed] << (pin * 2));
    await setBits(base + GPIO.PUPDR, pullMask, PULL_BITS[pull] << (pin * 2));

    if (mode === 'af') {
        logger.debug(`configPin: P${port}${pin} → AF${af}`);
    }
    logger.debug(`configPin: P${port}${pin} mode=${mode} pull=${pull} speed=${speed} otype=${otype} af=${afVal}`);
}

/**
 * STM32F1-specific GPIO config via CRL/CRH registers.
 * F1 has no AFRL/AFRH — AF function is selected by CNF bits in CRL/CRH.
 * 4-bit field per pin: [1:0]=MODE, [3:2]=CNF
 *   Input:  MODE=00, CNF: 00=analog, 01=floating, 10=pull
 *   Output: MODE=11(50MHz)/01(10MHz), CNF: 00=PP, 01=OD, 10=AF-PP, 11=AF-OD
 */
async function configPinF1(
    chip: ChipDef,
    port: string,
    pin: number,
    mode: GpioMode,
    pull: GpioPull,
    speed: GpioSpeed,
    otype: GpioOType
): Promise<void> {
    const base = gpioBaseAddr(chip, port);
    if (base === null) throw new Error(`Unknown GPIO port: ${port}`);

    let modeBits: number;  // 2 bits
    let cnfBits: number;   // 2 bits

    if (mode === 'analog') {
        modeBits = 0b00; cnfBits = 0b00;
    } else if (mode === 'input') {
        modeBits = 0b00;
        cnfBits = pull !== 'none' ? 0b10 : 0b01;  // pull=10, floating=01
    } else {
    // output or af — select speed
        modeBits = (speed === 'low' || speed === 'medium') ? 0b01 : 0b11;
        if (mode === 'af') {
            cnfBits = otype === 'open-drain' ? 0b11 : 0b10;  // AF-OD or AF-PP
        } else {
            cnfBits = otype === 'open-drain' ? 0b01 : 0b00;  // OD or PP
        }
    }

    const fieldVal = (cnfBits << 2) | modeBits;
    const reg = pin < 8 ? base + GPIO_F1.CRL : base + GPIO_F1.CRH;
    const bitPos = (pin < 8 ? pin : pin - 8) * 4;
    await setBits(reg, 0xF << bitPos, fieldVal << bitPos);

    // Pull-up/down: set or clear the ODR bit
    if (mode === 'input' && pull !== 'none') {
        await setBits(base + GPIO_F1.ODR, 1 << pin, pull === 'up' ? (1 << pin) : 0);
    }
    logger.debug(`configPinF1: P${port}${pin} mode=${mode}/${otype} field=0x${fieldVal.toString(16)}`);
}

/**
 * Configure a pin as output and drive it.
 * Handles both new GPIO (BSRR at 0x18) and F1 GPIO (BSRR at 0x10).
 */
export async function setGpioOutput(
    chip: ChipDef,
    pinStr: string,
    value: boolean
): Promise<void> {
    const p = parsePin(pinStr);
    if (!p) throw new Error(`Invalid pin: ${pinStr}`);
    await configPin(chip, p.port, p.pin, 'output');
    const base = gpioBaseAddr(chip, p.port);
    const bsrrOff = chip.gpioModel === 'f1' ? GPIO_F1.BSRR : GPIO.BSRR;
    const bit = 1 << p.pin;
    await mww(base + bsrrOff, value ? bit : (bit << 16));
}

// ─── SPI ─────────────────────────────────────────────────────────────────────

export interface SpiConfig {
    sck: string;    // e.g. 'PB3'
    miso: string;
    mosi: string;
    cs?: string;    // optional — configured as GPIO output (active-low)
    speedHz?: number;  // default: 4_000_000
    mode?: 0 | 1 | 2 | 3;  // SPI mode (CPOL/CPHA), default: 0
}

/**
 * Initialize SPI in master mode.
 * Configures the GPIO pins to their alternate functions, enables the clock,
 * and programs CR1/CR2 for the requested speed and mode.
 *
 * Chip must be in a state where peripheral registers can be written (not in
 * deep sleep with clocks gated). A simple firmware that keeps clocks on, or
 * an attached ST-Link that has already started the MCU, works fine.
 */
export async function initSpi(
    chip: ChipDef,
    spiName: string,         // 'SPI1' or 'SPI2'
    cfg: SpiConfig
): Promise<void> {
    const spi = spiName.toUpperCase();
    const spiBase = chip.peripherals[spi];
    if (!spiBase) throw new Error(`Unknown SPI: ${spiName}`);

    // Resolve alternate functions for SCK, MISO, MOSI
    const pins: Array<[string, string]> = [
        ['SCK', cfg.sck], ['MISO', cfg.miso], ['MOSI', cfg.mosi]
    ];

    for (const [signal, pinStr] of pins) {
        const p = parsePin(pinStr);
        if (!p) throw new Error(`Invalid ${signal} pin: ${pinStr}`);
        const af = lookupAF(chip, spi, signal, pinStr);
        if (af === null) throw new Error(`No AF mapping for ${spi} ${signal} on ${pinStr} for ${chip.family}`);
        await configPin(chip, p.port, p.pin, 'af', 'none', 'high', 'push-pull', af);
    }

    // Configure CS as GPIO output (not hardware NSS)
    if (cfg.cs) {
        const p = parsePin(cfg.cs);
        if (!p) throw new Error(`Invalid CS pin: ${cfg.cs}`);
        await configPin(chip, p.port, p.pin, 'output', 'none', 'high');
        const base = gpioBaseAddr(chip, p.port);
        await mww(base + GPIO.BSRR, 1 << p.pin);  // CS HIGH (deasserted)
    }

    // Enable SPI clock
    await enablePeriphClock(chip, spi);

    // Compute baudrate prescaler BR[2:0]: fSPI = fPCLK / 2^(BR+1)
    const targetHz = cfg.speedHz ?? 4_000_000;
    const br = computeSpiBR(chip.defaultClockHz, targetHz);
    const cpol = (cfg.mode ?? 0) >> 1;
    const cpha = (cfg.mode ?? 0) & 1;

    // Build CR1 — disable SPI first
    // SSM=1 (software NSS), SSI=1 (NSS high), MSTR=1, SPE=0 initially
    const cr1Base = (1 << 9) | (1 << 8) | (br << 3) | (1 << 2) | (cpol << 1) | cpha;

    if (chip.spiModel === 'fifo') {
    // Enhanced SPI (G0, F3, etc.): set DS[3:0]=0b0111 (8-bit) and FRXTH=1 in CR2
        await mww(spiBase + SPI_REG.CR1, cr1Base);           // SPE=0 during config
        await mww(spiBase + SPI_REG.CR2, 0x1700);            // FRXTH=1, DS=0111 (8-bit)
        await mww(spiBase + SPI_REG.CR1, cr1Base | (1 << 6)); // SPE=1
    } else {
    // Classic SPI (F0, F1, F4): DFF=0 in CR1 (8-bit), set all at once
        await mww(spiBase + SPI_REG.CR1, cr1Base | (1 << 6)); // SPE=1 with DFF=0
    }

    const actualHz = chip.defaultClockHz / Math.pow(2, br + 1);
    logger.info(`initSpi: ${spi} @ ~${(actualHz / 1e6).toFixed(2)} MHz, mode ${cfg.mode ?? 0}`);
}

/** Compute the best SPI BR[2:0] prescaler for a target clock. */
function computeSpiBR(pclkHz: number, targetHz: number): number {
    for (let br = 0; br <= 7; br++) {
        if (pclkHz / Math.pow(2, br + 1) <= targetHz) return br;
    }
    return 7; // minimum speed
}

// ─── I2C ─────────────────────────────────────────────────────────────────────

export interface I2cConfig {
    scl: string;
    sda: string;
    speedHz?: 100_000 | 400_000;
    timingrOverride?: number;  // set a custom TIMINGR value (overrides speedHz lookup)
}

/** Initialize I2C in master mode. Handles both new (TIMINGR) and legacy (CCR+TRISE) peripherals. */
export async function initI2c(
    chip: ChipDef,
    i2cName: string,
    cfg: I2cConfig
): Promise<void> {
    const i2c = i2cName.toUpperCase();
    const i2cBase = chip.peripherals[i2c];
    if (!i2cBase) throw new Error(`Unknown I2C: ${i2cName}`);

    // Configure SCL and SDA pins as AF open-drain with pull-up
    for (const [signal, pinStr] of [['SCL', cfg.scl], ['SDA', cfg.sda]] as const) {
        const p = parsePin(pinStr);
        if (!p) throw new Error(`Invalid ${signal} pin: ${pinStr}`);
        const af = lookupAF(chip, i2c, signal, pinStr);
        if (af === null) throw new Error(`No AF for ${i2c}_${signal} on ${pinStr} (${chip.family})`);
        await configPin(chip, p.port, p.pin, 'af', 'up', 'high', 'open-drain', af);
    }

    await enablePeriphClock(chip, i2c);

    if (chip.i2cModel === 'legacy') {
    // ── Legacy I2C (F1, F4) — CCR + TRISE ──────────────────────────────────
    // Disable I2C, configure, re-enable
        await mww(i2cBase + I2C_REG_LEGACY.CR1, 0);

        const speedHz = cfg.speedHz ?? 100_000;
        const freqMhz = Math.max(2, Math.round(chip.defaultClockHz / 1_000_000));
        // CR2: FREQ[5:0] = APB1 clock in MHz (must match actual APB1 for timing)
        await mww(i2cBase + I2C_REG_LEGACY.CR2, freqMhz);

        if (speedHz >= 400_000) {
            // Fast mode (400kHz): duty cycle 2:1 (DUTY=0), F/S=1
            // CCR = fPCLK / (3 * fI2C)
            const ccr = Math.ceil(chip.defaultClockHz / (3 * speedHz));
            await mww(i2cBase + I2C_REG_LEGACY.CCR, (1 << 15) | Math.max(1, ccr));
            await mww(i2cBase + I2C_REG_LEGACY.TRISE, Math.ceil(freqMhz * 0.3) + 1);
        } else {
            // Standard mode (100kHz): F/S=0, Thigh = Tlow = CCR * Tpclk
            // CCR = fPCLK / (2 * fI2C) = fPCLK / 200000
            const ccr = Math.ceil(chip.defaultClockHz / (2 * speedHz));
            await mww(i2cBase + I2C_REG_LEGACY.CCR, Math.max(4, ccr));
            // TRISE = fPCLK(MHz) * Tr_max(ns) / 1000 + 1 = FREQ_MHz + 1 (for Tr=1000ns)
            await mww(i2cBase + I2C_REG_LEGACY.TRISE, freqMhz + 1);
        }
        await mww(i2cBase + I2C_REG_LEGACY.CR1, 0x1); // PE=1
        logger.info(`initI2c: ${i2c} (legacy) @${speedHz}Hz FREQ=${freqMhz}MHz`);
    } else {
    // ── New I2C (G0, F0) — TIMINGR ─────────────────────────────────────────
        await mww(i2cBase + I2C_REG.CR1, 0);
        let timingr = cfg.timingrOverride;
        if (!timingr) {
            const key = (cfg.speedHz ?? 100_000) >= 400_000 ? '400k' : '100k';
            timingr = chip.i2cTimingr[key];
            if (!timingr) throw new Error(`No TIMINGR for ${chip.family} @ ${key}`);
        }
        await mww(i2cBase + I2C_REG.TIMINGR, timingr);
        await mww(i2cBase + I2C_REG.CR1, 0x1);
        logger.info(`initI2c: ${i2c} (new) TIMINGR=0x${timingr.toString(16)}`);
    }
}

// ─── PWM ─────────────────────────────────────────────────────────────────────

export interface PwmConfig {
    pin: string;        // e.g. 'PA8' (must match timer channel)
    channel: 1 | 2 | 3 | 4;
    frequencyHz?: number;  // PWM frequency (default: 1000 Hz)
    dutyPercent?: number;  // duty cycle 0–100 (default: 50)
}

/** Initialize a timer channel as PWM output (mode 1, non-inverted). */
export async function initPwm(
    chip: ChipDef,
    timerName: string,   // 'TIM1', 'TIM3', etc.
    cfg: PwmConfig
): Promise<void> {
    const tim = timerName.toUpperCase();
    const timBase = chip.peripherals[tim];
    if (!timBase) throw new Error(`Unknown timer: ${timerName}`);

    // Configure pin as AF for this timer channel
    const p = parsePin(cfg.pin);
    if (!p) throw new Error(`Invalid pin: ${cfg.pin}`);
    const signal = `CH${cfg.channel}`;
    const af = lookupAF(chip, tim, signal, cfg.pin);
    if (af === null) throw new Error(`No AF for ${tim}_${signal} on ${cfg.pin} for ${chip.family}`);
    await configPin(chip, p.port, p.pin, 'af', 'none', 'very-high', 'push-pull', af);

    await enablePeriphClock(chip, tim);

    const freq = cfg.frequencyHz ?? 1000;
    const duty = Math.max(0, Math.min(100, cfg.dutyPercent ?? 50));

    // Compute PSC and ARR for desired PWM frequency
    // fTIM = fPCLK (for APB1 with PCLK1 prescaler=1, or APB2)
    // fPWM = fTIM / ((PSC + 1) * (ARR + 1))
    const { psc, arr } = computePwmTimings(chip.defaultClockHz, freq);
    const ccr = Math.round((arr + 1) * duty / 100);

    // Disable timer, configure
    const cr1 = await mdwOne(timBase + TIM_REG.CR1);
    await mww(timBase + TIM_REG.CR1, cr1 & ~0x1);  // CEN=0

    await mww(timBase + TIM_REG.PSC, psc);
    await mww(timBase + TIM_REG.ARR, arr);

    // Set CCMRx for PWM mode 1 on the requested channel
    // OCxM = 110 (PWM mode 1), OCxPE = 1 (preload)
    const pwmBits = (0b110 << 4) | (1 << 3); // OCxM[2:0]<<4 | OCxPE
    const ch = cfg.channel;
    if (ch === 1) {
        await setBits(timBase + TIM_REG.CCMR1, 0xFF, pwmBits);        // OC1M + OC1PE
        await setBits(timBase + TIM_REG.CCER, 0x1, 0x1);             // CC1E
        await mww(timBase + TIM_REG.CCR1, ccr);
    } else if (ch === 2) {
        await setBits(timBase + TIM_REG.CCMR1, 0xFF00, pwmBits << 8);   // OC2M + OC2PE
        await setBits(timBase + TIM_REG.CCER, 0x10, 0x10);
        await mww(timBase + TIM_REG.CCR2, ccr);
    } else if (ch === 3) {
        await setBits(timBase + TIM_REG.CCMR2, 0xFF, pwmBits);
        await setBits(timBase + TIM_REG.CCER, 0x100, 0x100);
        await mww(timBase + TIM_REG.CCR3, ccr);
    } else {
        await setBits(timBase + TIM_REG.CCMR2, 0xFF00, pwmBits << 8);
        await setBits(timBase + TIM_REG.CCER, 0x1000, 0x1000);
        await mww(timBase + TIM_REG.CCR4, ccr);
    }

    // Advanced timers (TIM1, TIM8) require MOE=1 in BDTR to enable outputs
    const advancedTimers = ['TIM1', 'TIM8'];
    if (advancedTimers.includes(tim)) {
        await setBits(timBase + TIM_REG.BDTR, 0x8000, 0x8000);  // MOE=1
    }

    // UG event to load PSC/ARR into shadow registers, then enable
    await mww(timBase + TIM_REG.EGR, 0x1);  // UG
    await mww(timBase + TIM_REG.CR1, (cr1 & ~0x1) | 0x1);  // CEN=1

    logger.info(`initPwm: ${tim} CH${ch} @ ${freq}Hz, ${duty}% (PSC=${psc}, ARR=${arr}, CCR=${ccr})`);
}

/** Update PWM duty cycle without re-initializing the timer. */
export async function setPwmDuty(
    chip: ChipDef,
    timerName: string,
    channel: 1 | 2 | 3 | 4,
    dutyPercent: number
): Promise<void> {
    const timBase = chip.peripherals[timerName.toUpperCase()];
    if (!timBase) throw new Error(`Unknown timer: ${timerName}`);
    const arr = await mdwOne(timBase + TIM_REG.ARR);
    const ccr = Math.round((arr + 1) * Math.max(0, Math.min(100, dutyPercent)) / 100);
    const ccrReg = [TIM_REG.CCR1, TIM_REG.CCR2, TIM_REG.CCR3, TIM_REG.CCR4][channel - 1];
    await mww(timBase + ccrReg, ccr);
}

function computePwmTimings(clockHz: number, freqHz: number): { psc: number; arr: number } {
    // Target: clockHz / ((PSC+1) * (ARR+1)) = freqHz
    // Keep ARR as large as possible for best resolution (target ARR ~1000)
    const target = clockHz / freqHz;
    for (let arrTarget = 9999; arrTarget >= 99; arrTarget -= 100) {
        const psc = Math.round(target / (arrTarget + 1)) - 1;
        if (psc >= 0 && psc <= 65535) {
            const arr = Math.round(target / (psc + 1)) - 1;
            if (arr >= 1 && arr <= 65535) {
                return { psc, arr };
            }
        }
    }
    // Fallback
    const psc = Math.ceil(clockHz / (freqHz * 1000)) - 1;
    const arr = Math.round(clockHz / ((psc + 1) * freqHz)) - 1;
    return { psc: Math.max(0, psc), arr: Math.max(1, arr) };
}

// ─── SPI transaction ─────────────────────────────────────────────────────────

/**
 * Execute a full SPI transaction: assert CS, send/receive bytes, deassert CS.
 * The SPI peripheral must already be initialized with initSpi().
 * Uses OpenOCD sleep for transfer timing — safe at any SPI speed ≤ 8MHz.
 */
export async function spiTransferBytes(
    chip: ChipDef,
    spiName: string,
    csPin: string | null,
    txBytes: number[]
): Promise<number[]> {
    const spiBase = chip.peripherals[spiName.toUpperCase()];
    if (!spiBase) throw new Error(`Unknown SPI: ${spiName}`);
    const SPI_DR = spiBase + SPI_REG.DR;

    // Build command batch
    const cmds: string[] = [];
    const readPositions: number[] = [];

    // CS LOW
    if (csPin) {
        const { base: csBase, bit: csBit } = resolvePinBSRR(chip, csPin);
        cmds.push(`mww 0x${(csBase + GPIO.BSRR).toString(16)} 0x${(csBit << 16).toString(16)}`);
    }

    // For each byte: write DR, sleep, read DR
    for (const byte of txBytes) {
        cmds.push(`mwb 0x${SPI_DR.toString(16)} 0x${byte.toString(16)}`);
        cmds.push('sleep 2');   // 2ms >> 1-byte transfer time at any speed ≤ 8MHz
        readPositions.push(cmds.length);
        cmds.push(`mdb 0x${SPI_DR.toString(16)} 1`);
    }

    // CS HIGH
    if (csPin) {
        const { base: csBase, bit: csBit } = resolvePinBSRR(chip, csPin);
        cmds.push(`mww 0x${(csBase + GPIO.BSRR).toString(16)} 0x${csBit.toString(16)}`);
    }

    const responses = await openocdBatch(cmds);

    // Parse received bytes from mdb responses
    return readPositions.map((idx) => {
        const resp = responses[idx] ?? '';
        const m = resp.match(/0x[0-9a-f]+:\s+([0-9a-f]{2})/i);
        return m ? parseInt(m[1], 16) : 0xFF;
    });
}

// ─── I2C transaction ─────────────────────────────────────────────────────────

/**
 * Execute an I2C transaction.
 * Supports: write-only, read-only, or write-then-read (register read pattern).
 * Uses RELOAD mode for multi-byte reads (clock-stretching — no overrun risk).
 * The I2C peripheral must already be initialized with initI2c().
 */
export async function i2cTransaction(
    chip: ChipDef,
    i2cName: string,
    addr7: number,
    writeBytes: number[],
    readCount: number
): Promise<number[]> {
    const i2cBase = chip.peripherals[i2cName.toUpperCase()];
    if (!i2cBase) throw new Error(`Unknown I2C: ${i2cName}`);

    if (chip.i2cModel === 'legacy') {
        return i2cLegacyTransaction(i2cBase, addr7, writeBytes, readCount);
    }

    const CR2 = i2cBase + I2C_REG.CR2;
    const TXDR = i2cBase + I2C_REG.TXDR;
    const RXDR = i2cBase + I2C_REG.RXDR;

    // I2C CR2 bit helpers
    // SADD[7:1] = device address (bits [7:1]), bits [9:0]
    // RD_WRN at bit 10: 0=write, 1=read
    // NBYTES at bits [23:16]
    // START at bit 13
    // STOP at bit 14
    // AUTOEND at bit 25
    // RELOAD at bit 24

    const sadd = (addr7 & 0x7F) << 1;

    function cr2Write(nBytes: number, autoEnd: boolean): number {
        return sadd | (nBytes << 16) | (autoEnd ? (1 << 25) : 0) | (1 << 13);
    }

    function cr2Read(nBytes: number, withStart: boolean, reload: boolean, autoEnd: boolean): number {
        return sadd
      | (nBytes << 16)
      | (1 << 10)                         // RD_WRN=1
      | (withStart ? (1 << 13) : 0)       // START
      | (reload ? (1 << 24) : 0)          // RELOAD
      | (autoEnd ? (1 << 25) : 0);        // AUTOEND
    }

    const cmds: string[] = [];
    const readPositions: number[] = [];

    if (writeBytes.length > 0) {
    // Write phase: send all bytes, no AUTOEND (need TC to do repeated start for read)
        cmds.push(`mww 0x${CR2.toString(16)} 0x${cr2Write(writeBytes.length, readCount === 0).toString(16)}`);
        cmds.push('sleep 3');  // wait: start + address + first byte reception ready
        for (const byte of writeBytes) {
            cmds.push(`mwb 0x${TXDR.toString(16)} 0x${byte.toString(16)}`);
            cmds.push('sleep 2');  // ~100µs/byte at 100kHz, 2ms is safe
        }
    }

    if (readCount > 0) {
    // Read phase using RELOAD mode for reliable multi-byte reads.
    // RELOAD causes the hardware to stretch the clock (hold SCL low) after
    // each byte until software updates CR2 — no overrun risk.
        const withStart = true;  // generates RESTART after write phase (or START if no write)

        if (readCount === 1) {
            // Single byte: no RELOAD needed, just AUTOEND
            cmds.push(`mww 0x${CR2.toString(16)} 0x${cr2Read(1, withStart, false, true).toString(16)}`);
            cmds.push('sleep 4');  // start + address + 1 byte
            readPositions.push(cmds.length);
            cmds.push(`mdb 0x${RXDR.toString(16)} 1`);
        } else {
            // Multiple bytes: use RELOAD for all but the last
            for (let i = 0; i < readCount; i++) {
                const isLast = i === readCount - 1;
                const isFirst = i === 0;
                const reload = !isLast;
                const autoEnd = isLast;
                const start = isFirst && withStart;

                cmds.push(`mww 0x${CR2.toString(16)} 0x${cr2Read(1, start, reload, autoEnd).toString(16)}`);
                // First byte: wait for start + address + byte; subsequent: clock was stretched, wait for byte only
                cmds.push(isFirst ? 'sleep 4' : 'sleep 2');
                readPositions.push(cmds.length);
                cmds.push(`mdb 0x${RXDR.toString(16)} 1`);
            }
        }
    }

    const responses = await openocdBatch(cmds, 15_000);  // generous timeout for long transactions

    // Extract received bytes
    return readPositions.map((idx) => {
        const resp = responses[idx] ?? '';
        const m = resp.match(/0x[0-9a-f]+:\s+([0-9a-f]{2})/i);
        return m ? parseInt(m[1], 16) : 0xFF;
    });
}

// ─── Legacy I2C transaction (F1, F4) ─────────────────────────────────────────
//
// The old STM32 I2C peripheral (RM0008/RM0090) uses event flags (SB, ADDR, TXE,
// RXNE, BTF) and explicit START/STOP bits — completely different from the new
// I2C with NBYTES/RELOAD/AUTOEND.
//
// This function uses a sleep-based batch: each step waits 2ms, which is far more
// than the ~90µs per byte at 100kHz. Works reliably for testing; not for production.
//
// Batch sequence for "write N bytes then read M bytes":
//   START → address+W → clear ADDR → write bytes
//   → RESTART → address+R → ACK → clear ADDR → read M bytes → STOP

async function i2cLegacyTransaction(
    i2cBase: number,
    addr7: number,
    writeBytes: number[],
    readCount: number
): Promise<number[]> {
    const CR1 = i2cBase + I2C_REG_LEGACY.CR1;
    const DR = i2cBase + I2C_REG_LEGACY.DR;
    const SR2 = i2cBase + I2C_REG_LEGACY.SR2;

    const addrW = `0x${((addr7 << 1) | 0).toString(16)}`;
    const addrR = `0x${((addr7 << 1) | 1).toString(16)}`;
    const CR1_PE = '0x0001';  // PE only
    const CR1_START = '0x0101';  // PE + START
    const CR1_START_ACK = '0x0501';  // PE + START + ACK (for read phase)
    const CR1_STOP = '0x0201';  // PE + STOP (ACK cleared)

    const cmds: string[] = [];
    const readPositions: number[] = [];

    if (writeBytes.length > 0) {
    // Write phase
        cmds.push(`mww 0x${CR1.toString(16)} ${CR1_START}`);
        cmds.push('sleep 2');
        cmds.push(`mww 0x${DR.toString(16)} ${addrW}`);
        cmds.push('sleep 2');
        cmds.push(`mdw 0x${SR2.toString(16)} 1`);  // reading SR2 clears ADDR flag
        for (const byte of writeBytes) {
            cmds.push(`mww 0x${DR.toString(16)} 0x${byte.toString(16)}`);
            cmds.push('sleep 2');
        }
    }

    if (readCount > 0) {
    // Read phase with RESTART
        cmds.push(`mww 0x${CR1.toString(16)} ${CR1_START_ACK}`);
        cmds.push('sleep 2');
        cmds.push(`mww 0x${DR.toString(16)} ${addrR}`);
        cmds.push('sleep 2');
        cmds.push(`mdw 0x${SR2.toString(16)} 1`);  // clear ADDR

        if (readCount === 1) {
            // For single byte: set STOP before data arrives (before reading SR2 in strict HW)
            // With 2ms sleep, the byte has arrived → read DR, then set STOP
            cmds.push('sleep 2');
            readPositions.push(cmds.length);
            cmds.push(`mdb 0x${DR.toString(16)} 1`);
            cmds.push(`mww 0x${CR1.toString(16)} ${CR1_STOP}`);
        } else {
            // Read N-1 bytes with ACK (automatic), then STOP before last
            for (let i = 0; i < readCount - 1; i++) {
                cmds.push('sleep 2');
                readPositions.push(cmds.length);
                cmds.push(`mdb 0x${DR.toString(16)} 1`);
            }
            // Before last byte: clear ACK, set STOP
            cmds.push(`mww 0x${CR1.toString(16)} ${CR1_STOP}`);
            cmds.push('sleep 2');
            readPositions.push(cmds.length);
            cmds.push(`mdb 0x${DR.toString(16)} 1`);
        }
    } else {
    // Write only: set STOP after last byte
        cmds.push(`mww 0x${CR1.toString(16)} ${CR1_STOP}`);
    }

    // Final: re-enable PE cleanly
    cmds.push(`mww 0x${CR1.toString(16)} ${CR1_PE}`);

    const responses = await openocdBatch(cmds, 20_000);

    return readPositions.map((idx) => {
        const resp = responses[idx] ?? '';
        // mdb response: "0x40005410: 68"
        const m = resp.match(/0x[0-9a-f]+:\s+([0-9a-f]{2})/i);
        return m ? parseInt(m[1], 16) : 0xFF;
    });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function resolvePinBSRR(chip: ChipDef, pinStr: string): { base: number; bit: number } {
    const p = parsePin(pinStr);
    if (!p) throw new Error(`Invalid pin: ${pinStr}`);
    const base = gpioBaseAddr(chip, p.port);
    if (base === null) throw new Error(`Unknown GPIO port: ${p.port}`);
    return { base, bit: 1 << p.pin };
}

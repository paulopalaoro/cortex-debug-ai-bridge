/**
 * STM32 chip register map — base addresses, peripheral offsets, pin AF numbers.
 * Covers STM32G0 (G030/G031/G041/G070/G071), STM32F0 (F042/F030/F072),
 * and STM32F4 (F407/F405/F427/F429/F446).
 *
 * Used by stm32Init.ts and the peripheral tools to avoid hardcoding addresses.
 */

// Old I2C register offsets (STM32F1/F2/F4/L1 — legacy peripheral without TIMINGR)
export const I2C_REG_LEGACY = {
    CR1: 0x00,
    CR2: 0x04,
    OAR1: 0x08,
    OAR2: 0x0C,
    DR: 0x10,
    SR1: 0x14,
    SR2: 0x18,
    CCR: 0x1C,
    TRISE: 0x20,
};

// STM32F1 GPIO register offsets (completely different from F0/F4/G0!)
// Each pin has 4 bits in CRL (pins 0-7) or CRH (pins 8-15):
//   [1:0] = MODE: 00=input, 01=out10MHz, 10=out2MHz, 11=out50MHz
//   [3:2] = CNF: in output mode: 00=PP, 01=OD, 10=AF-PP, 11=AF-OD
//           in input mode:  00=analog, 01=floating, 10=pull
export const GPIO_F1 = {
    CRL: 0x00,  // pins 0-7 (4 bits each)
    CRH: 0x04,  // pins 8-15 (4 bits each)
    IDR: 0x08,
    ODR: 0x0C,
    BSRR: 0x10,  // NOTE: at 0x10 on F1, not 0x18 like F0/F4/G0!
    BRR: 0x14,
    LCKR: 0x18,
};

// ─── GPIO register offsets (same for all STM32 families) ────────────────────
export const GPIO = {
    MODER: 0x00,  // mode: 00=input, 01=output, 10=AF, 11=analog
    OTYPER: 0x04,  // output type: 0=push-pull, 1=open-drain
    OSPEEDR: 0x08,  // speed: 00=low, 01=medium, 10=high, 11=very-high
    PUPDR: 0x0C,  // pull: 00=none, 01=up, 10=down
    IDR: 0x10,  // input data (read-only)
    ODR: 0x14,  // output data
    BSRR: 0x18,  // bit set/reset: lower 16 = set, upper 16 = reset
    AFRL: 0x20,  // alternate function low (pins 0–7, 4 bits each)
    AFRH: 0x24,  // alternate function high (pins 8–15, 4 bits each)
    BRR: 0x28,  // bit reset register (lower 16 = reset)
};

// ─── CAN register offsets (bxCAN — F1/F4/F3) ────────────────────────────────
export const CAN_REG = {
    MCR: 0x00,   // Master Control
    MSR: 0x04,   // Master Status
    TSR: 0x08,   // Transmit Status
    RF0R: 0x0C,   // Receive FIFO 0
    RF1R: 0x10,   // Receive FIFO 1
    IER: 0x14,   // Interrupt Enable
    ESR: 0x18,   // Error Status
    BTR: 0x1C,   // Bit Timing (configure before init)
    // Filter bank registers (shared, controlled by CAN1)
    FMR: 0x200,  // Filter Master Register (FINIT bit 0)
    FM1R: 0x204,  // Filter Mode  (0=mask, 1=list) — 1 bit per bank
    FS1R: 0x20C,  // Filter Scale (0=16-bit, 1=32-bit) — 1 bit per bank
    FFA1R: 0x214,  // Filter FIFO  (0=FIFO0, 1=FIFO1) — 1 bit per bank
    FA1R: 0x21C,  // Filter Active (1=active) — 1 bit per bank
    F0R1: 0x240,  // Bank 0 R1 (ID / ID1). Bank N: 0x240 + N*8
    F0R2: 0x244,  // Bank 0 R2 (Mask / ID2). Bank N: 0x244 + N*8
};

// ─── RTC register offsets (new RTC — F2/F4/F7/L0/L4/G0/H7) ──────────────────
export const RTC_REG = {
    TR: 0x00,   // Time Register (BCD: hour/min/sec)
    DR: 0x04,   // Date Register (BCD: year/month/day)
    CR: 0x08,   // Control Register
    ISR: 0x0C,   // Initialization and Status
    PRER: 0x10,   // Prescaler (PREDIV_A | PREDIV_S)
    WUTR: 0x14,   // Wakeup Timer
    ALRMAR: 0x1C,   // Alarm A
    ALRMBR: 0x20,   // Alarm B
    WPR: 0x24,   // Write Protection (write 0xCA then 0x53 to unlock)
    SSR: 0x28,   // Sub Second
    BKP0R: 0x50,   // Backup Register 0 (20 × 4 bytes: BKP0R–BKP19R)
};

// ─── USART register offsets (new — G0/F0/F3/L0/L4/H7) ───────────────────────
export const USART_REG = {
    CR1: 0x00,   // Control 1 (UE, TE, RE, M, PCE, PS, TXEIE, RXNEIE, etc.)
    CR2: 0x04,   // Control 2 (STOP bits, LINEN, etc.)
    CR3: 0x08,   // Control 3 (DMA, flow control, etc.)
    BRR: 0x0C,   // Baud Rate Register
    GTPR: 0x10,   // Guard Time and Prescaler
    RTOR: 0x14,   // Receiver Timeout
    RQR: 0x18,   // Request Register
    ISR: 0x1C,   // Interrupt and Status
    ICR: 0x20,   // Interrupt Clear
    RDR: 0x24,   // Receive Data Register
    TDR: 0x28,   // Transmit Data Register
};

// ─── USART register offsets (legacy — F1/F4/F2) ──────────────────────────────
export const USART_REG_LEGACY = {
    SR: 0x00,   // Status (TXE, TC, RXNE, etc.)
    DR: 0x04,   // Data Register (TX write / RX read)
    BRR: 0x08,   // Baud Rate Register
    CR1: 0x0C,   // Control 1
    CR2: 0x10,   // Control 2
    CR3: 0x14,   // Control 3
    GTPR: 0x18,   // Guard Time and Prescaler
};

// ─── SPI register offsets ───────────────────────────────────────────────────
export const SPI_REG = {
    CR1: 0x00,
    CR2: 0x04,
    SR: 0x08,
    DR: 0x0C,
};

// ─── I2C register offsets (new STM32 I2C: G0, F0, F3, L0, etc.) ─────────────
export const I2C_REG = {
    CR1: 0x00,
    CR2: 0x04,
    OAR1: 0x08,
    OAR2: 0x0C,
    TIMINGR: 0x10,
    TIMEOUTR: 0x14,
    ISR: 0x18,
    ICR: 0x1C,
    PECR: 0x20,
    RXDR: 0x24,
    TXDR: 0x28,
};

// I2C_ISR bit positions
export const I2C_ISR = {
    TXIS: 1,   // transmit data register empty
    RXNE: 2,   // receive data register not empty (wait, bit 2 is actually RXNE? let me check)
    // Actually: bit 0=TXE, bit 1=TXIS, bit 2=RXNE, bit 3=ADDR, bit 4=NACKF,
    //           bit 5=STOPF, bit 6=TC, bit 7=TCR, bit 8=BERR, bit 9=ARLO,
    //           bit 10=OVR, bit 15=BUSY
    TXE: 0,
    RXNE_B: 2,
    TC: 6,
    TCR: 7,
    BUSY: 15,
};

// ─── TIM register offsets ───────────────────────────────────────────────────
export const TIM_REG = {
    CR1: 0x00,
    CR2: 0x04,
    SMCR: 0x08,
    DIER: 0x0C,
    SR: 0x10,
    EGR: 0x14,
    CCMR1: 0x18,
    CCMR2: 0x1C,
    CCER: 0x20,
    CNT: 0x24,
    PSC: 0x28,
    ARR: 0x2C,
    RCR: 0x30,  // advanced only (TIM1)
    CCR1: 0x34,
    CCR2: 0x38,
    CCR3: 0x3C,
    CCR4: 0x40,
    BDTR: 0x44,  // break and dead-time (advanced only, TIM1)
};

// ─── Chip definitions ───────────────────────────────────────────────────────

export interface ChipDef {
    /** Short family identifier used as key */
    family: string;
    /** Human-readable name */
    name: string;
    /** SPI peripheral model: 'basic' (DFF in CR1, no FIFO) or 'fifo' (DS in CR2, FIFO) */
    spiModel: 'basic' | 'fifo';
    /** Default core clock in Hz (used for baudrate prescaler calculations) */
    defaultClockHz: number;
    /** GPIO port → base address */
    gpioBase: Record<string, number>;
    /** RCC register addresses (absolute) */
    rcc: {
        base: number;
        gpioEnReg: number;       // absolute address of the GPIO enable register
        gpioEnBit: Record<string, number>;  // port letter → bit number
        apb1EnReg: number;       // absolute address of APB1 enable register
        apb2EnReg: number;       // absolute address of APB2 enable register
        apb1EnBit: Record<string, number>;  // peripheral name → bit number
        apb2EnBit: Record<string, number>;
    };
    /** Peripheral name → base address */
    peripherals: Record<string, number>;
    /**
   * Pin alternate function mapping.
   * Key format: "PERIPH_SIGNAL_Pxn" → AF number
   * Example: "SPI1_SCK_PB3" → 0
   */
    pinAf: Record<string, number>;
    /**
   * GPIO register model.
   * 'new': MODER/OTYPER/OSPEEDR/PUPDR/AFRL/AFRH (F0, F4, G0, F3, L0, H7)
   * 'f1':  CRL/CRH — 4-bit CNF/MODE per pin, no AFRL/AFRH (F1, F2)
   */
    gpioModel: 'new' | 'f1';
    /**
   * I2C peripheral model.
   * 'new': new I2C with TIMINGR (G0, F0, F3, L0, H7, G4)
   * 'legacy': old I2C with CCR+TRISE (F1, F2, F4, L1)
   */
    i2cModel: 'new' | 'legacy';
    /** I2C TIMINGR for common speeds at default clock ('new' model only) */
    i2cTimingr: Record<string, number>;  // key: '100k' | '400k'
}

// ─── STM32G0 (G030, G031, G041, G070, G071) ─────────────────────────────────
// Reference: RM0454 (G030/G031/G041), RM0444 (G071)
// GPIO base: 0x50000000
// PCLK defaults: 16MHz internal oscillator (can be configured up to 64MHz via PLL)
// When using PlatformIO with arduino framework, default PLL = 64MHz

export const STM32G0: ChipDef = {
    family: 'stm32g0',
    name: 'STM32G030/G031/G041/G070/G071',
    gpioModel: 'new',
    spiModel: 'fifo',         // enhanced SPI with DS in CR2 and FIFO
    i2cModel: 'new',          // new I2C with TIMINGR register
    defaultClockHz: 64_000_000,

    gpioBase: {
        A: 0x50000000,
        B: 0x50000400,
        C: 0x50000800,
        D: 0x50000C00,
        F: 0x50001400,
    },

    rcc: {
        base: 0x40021000,
        gpioEnReg: 0x40021034,  // RCC_IOPENR
        gpioEnBit: { A: 0, B: 1, C: 2, D: 3, F: 5 },
        apb1EnReg: 0x4002103C,  // RCC_APBENR1
        apb2EnReg: 0x40021040,  // RCC_APBENR2
        apb1EnBit: {
            TIM3: 1,
            TIM6: 4,
            TIM7: 5,
            USART2: 17,
            USART3: 18,
            I2C1: 21,
            I2C2: 22,
        },
        apb2EnBit: {
            SYSCFG: 0,
            TIM1: 11,
            SPI1: 12,
            USART1: 14,
            TIM14: 15,
            TIM15: 16,
            TIM16: 17,
            TIM17: 18,
            ADC: 20,
        },
    },

    peripherals: {
        SPI1: 0x40013000,
        I2C1: 0x40005400,
        I2C2: 0x40005800,
        TIM1: 0x40012C00,
        TIM3: 0x40000400,
        TIM6: 0x40001000,
        TIM7: 0x40001400,
        TIM14: 0x40002000,
        TIM15: 0x40014000,
        TIM16: 0x40014400,
        TIM17: 0x40014800,
        USART1: 0x40013800,
        USART2: 0x40004400,
        USART3: 0x40004800,
        ADC: 0x40012400,
        RTC: 0x40002800,
    },

    pinAf: {
    // SPI1
        'SPI1_SCK_PA5': 0, 'SPI1_SCK_PB3': 0,
        'SPI1_MISO_PA6': 0, 'SPI1_MISO_PB4': 0,
        'SPI1_MOSI_PA7': 0, 'SPI1_MOSI_PB5': 0,
        'SPI1_NSS_PA4': 0, 'SPI1_NSS_PA15': 0, 'SPI1_NSS_PB0': 0,

        // I2C1
        'I2C1_SCL_PA9': 6, 'I2C1_SCL_PB6': 6, 'I2C1_SCL_PB8': 6,
        'I2C1_SDA_PA10': 6, 'I2C1_SDA_PB7': 6, 'I2C1_SDA_PB9': 6,

        // I2C2
        'I2C2_SCL_PA11': 6, 'I2C2_SCL_PB10': 6,
        'I2C2_SDA_PA12': 6, 'I2C2_SDA_PB11': 6,

        // TIM1 PWM channels
        'TIM1_CH1_PA8': 2,
        'TIM1_CH2_PA9': 2,
        'TIM1_CH3_PA10': 2,
        'TIM1_CH4_PA11': 2,
        'TIM1_CH1N_PA7': 2, 'TIM1_CH1N_PB13': 2,
        'TIM1_CH2N_PB0': 2, 'TIM1_CH2N_PB14': 2,
        'TIM1_CH3N_PB1': 2, 'TIM1_CH3N_PB15': 2,

        // TIM3 PWM channels
        'TIM3_CH1_PA6': 1, 'TIM3_CH1_PB4': 1,
        'TIM3_CH2_PA7': 1, 'TIM3_CH2_PB5': 1,
        'TIM3_CH3_PB0': 1,
        'TIM3_CH4_PB1': 1,

        // TIM14/15/16/17 (single channel timers)
        'TIM14_CH1_PA4': 4, 'TIM14_CH1_PB1': 0,
        'TIM15_CH1_PA2': 0, 'TIM15_CH2_PA3': 0,
        'TIM16_CH1_PA6': 5, 'TIM16_CH1_PB8': 2,
        'TIM17_CH1_PA7': 5, 'TIM17_CH1_PB9': 2,

        // USART1
        'USART1_TX_PA9': 1, 'USART1_TX_PB6': 0,
        'USART1_RX_PA10': 1, 'USART1_RX_PB7': 0,

        // USART2
        'USART2_TX_PA2': 1, 'USART2_TX_PA14': 1,
        'USART2_RX_PA3': 1, 'USART2_RX_PA15': 1,

        // USART3
        'USART3_TX_PB2': 4, 'USART3_TX_PB8': 4, 'USART3_TX_PC4': 1,
        'USART3_RX_PB0': 4, 'USART3_RX_PB9': 4, 'USART3_RX_PC5': 1,
    },

    // TIMINGR values for @ 64MHz PCLK (PLL default in arduino/PIO).
    // Generated using AN4235 formula. Verified for 100kHz:
    //   PRESC=15 (÷16 → 250ns/tick), SCLL=0x13 (5µs), SCLH=0x0F (4µs) → ~100kHz ✓
    // For 400kHz: PRESC=3 (÷4 → 62.5ns/tick), SCLL=0x13 (1.25µs), SCLH=0x0B (~0.75µs)
    i2cTimingr: {
        '100k': 0xF0420F13,
        '400k': 0x30310B13,
    },
};

// ─── STM32F0 (F042, F030, F031, F051, F072) ──────────────────────────────────
// Reference: RM0091
// GPIO base: 0x48000000
// PCLK: up to 48MHz

export const STM32F0: ChipDef = {
    family: 'stm32f0',
    name: 'STM32F042/F030/F031/F051/F072',
    gpioModel: 'new',
    spiModel: 'basic',        // classic SPI: DFF in CR1, no FIFO
    i2cModel: 'new',          // new I2C with TIMINGR register
    defaultClockHz: 48_000_000,

    gpioBase: {
        A: 0x48000000,
        B: 0x48000400,
        C: 0x48000800,
        D: 0x48000C00,
        F: 0x48001400,
    },

    rcc: {
        base: 0x40021000,
        gpioEnReg: 0x40021014,  // RCC_AHBENR
        gpioEnBit: { A: 17, B: 18, C: 19, D: 20, F: 22 },
        apb1EnReg: 0x4002101C,  // RCC_APB1ENR
        apb2EnReg: 0x40021018,  // RCC_APB2ENR
        apb1EnBit: {
            TIM2: 0,
            TIM3: 1,
            TIM6: 4,
            TIM7: 5,
            USART2: 17,
            USART3: 18,
            I2C1: 21,
            I2C2: 22,
        },
        apb2EnBit: {
            SYSCFG: 0,
            ADC: 9,
            TIM1: 11,
            SPI1: 12,
            USART1: 14,
            TIM15: 16,
            TIM16: 17,
            TIM17: 18,
        },
    },

    peripherals: {
        SPI1: 0x40013000,
        I2C1: 0x40005400,
        I2C2: 0x40005800,
        TIM1: 0x40012C00,
        TIM2: 0x40000000,
        TIM3: 0x40000400,
        TIM6: 0x40001000,
        TIM7: 0x40001400,
        TIM14: 0x40002000,
        TIM15: 0x40014000,
        TIM16: 0x40014400,
        TIM17: 0x40014800,
        USART1: 0x40013800,
        USART2: 0x40004400,
        USART3: 0x40004800,
        ADC: 0x40012400,
        RTC: 0x40002800,
    },

    pinAf: {
    // SPI1
        'SPI1_SCK_PA5': 0, 'SPI1_SCK_PB3': 0,
        'SPI1_MISO_PA6': 0, 'SPI1_MISO_PB4': 0,
        'SPI1_MOSI_PA7': 0, 'SPI1_MOSI_PB5': 0,
        'SPI1_NSS_PA4': 0, 'SPI1_NSS_PA15': 0,

        // I2C1 — F042 specific: PB6/PB7 = AF1, PA9/PA10 = AF4
        'I2C1_SCL_PB6': 1, 'I2C1_SCL_PA9': 4,
        'I2C1_SDA_PB7': 1, 'I2C1_SDA_PA10': 4,

        // I2C2 (F072, some F0x2 variants)
        'I2C2_SCL_PB10': 1, 'I2C2_SCL_PF6': 0,
        'I2C2_SDA_PB11': 1, 'I2C2_SDA_PF7': 0,

        // TIM1
        'TIM1_CH1_PA8': 2,
        'TIM1_CH2_PA9': 2,
        'TIM1_CH3_PA10': 2,
        'TIM1_CH4_PA11': 2,
        'TIM1_CH1N_PA7': 2, 'TIM1_CH1N_PB13': 2,
        'TIM1_CH2N_PB0': 2, 'TIM1_CH2N_PB14': 2,
        'TIM1_CH3N_PB1': 2, 'TIM1_CH3N_PB15': 2,

        // TIM2
        'TIM2_CH1_PA0': 2, 'TIM2_CH1_PA5': 2, 'TIM2_CH1_PA15': 2,
        'TIM2_CH2_PA1': 2, 'TIM2_CH2_PB3': 2,
        'TIM2_CH3_PA2': 2, 'TIM2_CH3_PB10': 2,
        'TIM2_CH4_PA3': 2, 'TIM2_CH4_PB11': 2,

        // TIM3
        'TIM3_CH1_PA6': 1, 'TIM3_CH1_PB4': 1,
        'TIM3_CH2_PA7': 1, 'TIM3_CH2_PB5': 1,
        'TIM3_CH3_PB0': 1,
        'TIM3_CH4_PB1': 1,

        // USART1
        'USART1_TX_PA9': 1, 'USART1_TX_PB6': 0,
        'USART1_RX_PA10': 1, 'USART1_RX_PB7': 0,

        // USART2
        'USART2_TX_PA2': 1, 'USART2_TX_PA14': 1,
        'USART2_RX_PA3': 1, 'USART2_RX_PA15': 1,

        // USART3 (F072/F091)
        'USART3_TX_PB10': 4, 'USART3_TX_PC4': 1,
        'USART3_RX_PB11': 4, 'USART3_RX_PC5': 1,
    },

    // TIMINGR values for @ 48MHz PCLK.
    // 100kHz: PRESC=11 (÷12 → 250ns/tick), SCLL=0x13 (5µs), SCLH=0x0F (4µs)
    i2cTimingr: {
        '100k': 0xB0420F13,
        '400k': 0x00310309,
    },
};

// ─── STM32F4 (F405, F407, F415, F417, F427, F429, F446) ──────────────────────
// Reference: RM0090
// GPIO base: 0x40020000 — AHB1 bus
// APB1 (≤42MHz), APB2 (≤84MHz) at typical 168MHz PLL config
// NOTE: Uses LEGACY I2C (CCR+TRISE, no TIMINGR). SPI = classic (same as F0).
// Blank chip reset state: HSI = 16MHz, no PLL → defaultClockHz = 16MHz.

export const STM32F4: ChipDef = {
    family: 'stm32f4',
    name: 'STM32F405/F407/F415/F417/F427/F429/F446',
    gpioModel: 'new',
    spiModel: 'basic',        // classic SPI: DFF in CR1, no FIFO
    i2cModel: 'legacy',       // old I2C: CCR + TRISE registers (no TIMINGR)
    defaultClockHz: 16_000_000, // HSI default on blank chip; typically 168MHz with PLL

    gpioBase: {
        A: 0x40020000,
        B: 0x40020400,
        C: 0x40020800,
        D: 0x40020C00,
        E: 0x40021000,
        F: 0x40021400,
        G: 0x40021800,
        H: 0x40021C00,
        I: 0x40022000,
    },

    rcc: {
        base: 0x40023800,
        gpioEnReg: 0x40023830,  // RCC_AHB1ENR
        gpioEnBit: { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8 },
        apb1EnReg: 0x40023840,  // RCC_APB1ENR
        apb2EnReg: 0x40023844,  // RCC_APB2ENR
        apb1EnBit: {
            TIM2: 0, TIM3: 1, TIM4: 2, TIM5: 3,
            TIM6: 4, TIM7: 5, TIM12: 6, TIM13: 7, TIM14: 8,
            SPI2: 14, SPI3: 15,
            USART2: 17, USART3: 18, UART4: 19, UART5: 20,
            I2C1: 21, I2C2: 22, I2C3: 23,
            CAN1: 25, CAN2: 26,
        },
        apb2EnBit: {
            TIM1: 0, TIM8: 1,
            USART1: 4, USART6: 5,
            ADC1: 8, ADC2: 9, ADC3: 10,
            SPI1: 12, SPI4: 13,
            SYSCFG: 14,
            TIM9: 16, TIM10: 17, TIM11: 18,
        },
    },

    peripherals: {
        SPI1: 0x40013000,  // APB2
        SPI2: 0x40003800,  // APB1
        SPI3: 0x40003C00,  // APB1
        SPI4: 0x40013400,  // APB2
        I2C1: 0x40005400,
        I2C2: 0x40005800,
        I2C3: 0x40005C00,
        CAN1: 0x40006400,  // APB1
        CAN2: 0x40006800,  // APB1
        RTC: 0x40002800,  // APB1 (backup domain — unlock via PWR+RCC_BDCR first)
        TIM1: 0x40010000,  // APB2 advanced
        TIM2: 0x40000000,
        TIM3: 0x40000400,
        TIM4: 0x40000800,
        TIM5: 0x40000C00,
        TIM6: 0x40001000,
        TIM7: 0x40001400,
        TIM8: 0x40010400,  // APB2 advanced
        TIM9: 0x40014000,
        TIM10: 0x40014400,
        TIM11: 0x40014800,
        TIM12: 0x40001800,
        TIM13: 0x40001C00,
        TIM14: 0x40002000,
        USART1: 0x40011000,
        USART2: 0x40004400,
        USART3: 0x40004800,
        UART4: 0x40004C00,
        UART5: 0x40005000,
        USART6: 0x40011400,
        ADC1: 0x40012000,
        ADC2: 0x40012100,
        ADC3: 0x40012200,
    },

    pinAf: {
    // SPI1 — AF5
        'SPI1_NSS_PA4': 5, 'SPI1_NSS_PA15': 5,
        'SPI1_SCK_PA5': 5, 'SPI1_SCK_PB3': 5,
        'SPI1_MISO_PA6': 5, 'SPI1_MISO_PB4': 5,
        'SPI1_MOSI_PA7': 5, 'SPI1_MOSI_PB5': 5,

        // SPI2 — AF5
        'SPI2_NSS_PB9': 5, 'SPI2_NSS_PB12': 5,
        'SPI2_SCK_PB10': 5, 'SPI2_SCK_PB13': 5, 'SPI2_SCK_PC7': 5,
        'SPI2_MISO_PB14': 5, 'SPI2_MISO_PC2': 5,
        'SPI2_MOSI_PB15': 5, 'SPI2_MOSI_PC3': 5,

        // SPI3 — AF6
        'SPI3_NSS_PA4': 6, 'SPI3_NSS_PA15': 6,
        'SPI3_SCK_PB3': 6, 'SPI3_SCK_PC10': 6,
        'SPI3_MISO_PB4': 6, 'SPI3_MISO_PC11': 6,
        'SPI3_MOSI_PB5': 6, 'SPI3_MOSI_PC12': 6, 'SPI3_MOSI_PD6': 5,

        // I2C1 — AF4
        'I2C1_SCL_PB6': 4, 'I2C1_SCL_PB8': 4,
        'I2C1_SDA_PB7': 4, 'I2C1_SDA_PB9': 4,

        // I2C2 — AF4
        'I2C2_SCL_PB10': 4, 'I2C2_SCL_PF1': 4,
        'I2C2_SDA_PB11': 4, 'I2C2_SDA_PF0': 4,

        // I2C3 — AF4
        'I2C3_SCL_PA8': 4,
        'I2C3_SDA_PC9': 4,

        // TIM1 — AF1
        'TIM1_CH1_PA8': 1, 'TIM1_CH1_PE9': 1,
        'TIM1_CH2_PA9': 1, 'TIM1_CH2_PE11': 1,
        'TIM1_CH3_PA10': 1, 'TIM1_CH3_PE13': 1,
        'TIM1_CH4_PA11': 1, 'TIM1_CH4_PE14': 1,
        'TIM1_CH1N_PA7': 1, 'TIM1_CH1N_PB13': 1,
        'TIM1_CH2N_PB0': 1, 'TIM1_CH2N_PB14': 1,
        'TIM1_CH3N_PB1': 1, 'TIM1_CH3N_PB15': 1,

        // TIM2 — AF1
        'TIM2_CH1_PA0': 1, 'TIM2_CH1_PA5': 1, 'TIM2_CH1_PA15': 1,
        'TIM2_CH2_PA1': 1, 'TIM2_CH2_PB3': 1,
        'TIM2_CH3_PA2': 1, 'TIM2_CH3_PB10': 1,
        'TIM2_CH4_PA3': 1, 'TIM2_CH4_PB11': 1,

        // TIM3 — AF2
        'TIM3_CH1_PA6': 2, 'TIM3_CH1_PB4': 2, 'TIM3_CH1_PC6': 2,
        'TIM3_CH2_PA7': 2, 'TIM3_CH2_PB5': 2, 'TIM3_CH2_PC7': 2,
        'TIM3_CH3_PB0': 2, 'TIM3_CH3_PC8': 2,
        'TIM3_CH4_PB1': 2, 'TIM3_CH4_PC9': 2,

        // TIM4 — AF2
        'TIM4_CH1_PB6': 2, 'TIM4_CH1_PD12': 2,
        'TIM4_CH2_PB7': 2, 'TIM4_CH2_PD13': 2,
        'TIM4_CH3_PB8': 2, 'TIM4_CH3_PD14': 2,
        'TIM4_CH4_PB9': 2, 'TIM4_CH4_PD15': 2,

        // TIM5 — AF2
        'TIM5_CH1_PA0': 2, 'TIM5_CH1_PH10': 2,
        'TIM5_CH2_PA1': 2, 'TIM5_CH2_PH11': 2,
        'TIM5_CH3_PA2': 2, 'TIM5_CH3_PH12': 2,
        'TIM5_CH4_PA3': 2, 'TIM5_CH4_PI0': 2,

        // TIM8 — AF3 (advanced timer)
        'TIM8_CH1_PC6': 3, 'TIM8_CH1_PI5': 3,
        'TIM8_CH2_PC7': 3, 'TIM8_CH2_PI6': 3,
        'TIM8_CH3_PC8': 3, 'TIM8_CH3_PI7': 3,
        'TIM8_CH4_PC9': 3, 'TIM8_CH4_PI2': 3,
        'TIM8_CH1N_PA5': 3, 'TIM8_CH1N_PA7': 3, 'TIM8_CH1N_PH13': 3,
        'TIM8_CH2N_PB0': 3, 'TIM8_CH2N_PB14': 3, 'TIM8_CH2N_PH14': 3,
        'TIM8_CH3N_PB1': 3, 'TIM8_CH3N_PB15': 3, 'TIM8_CH3N_PH15': 3,

        // TIM9 — AF3
        'TIM9_CH1_PA2': 3, 'TIM9_CH1_PE5': 3,
        'TIM9_CH2_PA3': 3, 'TIM9_CH2_PE6': 3,

        // TIM10 — AF3
        'TIM10_CH1_PB8': 3, 'TIM10_CH1_PF6': 3,

        // TIM11 — AF3
        'TIM11_CH1_PB9': 3, 'TIM11_CH1_PF7': 3,

        // TIM12 — AF9
        'TIM12_CH1_PB14': 9, 'TIM12_CH1_PH6': 9,
        'TIM12_CH2_PB15': 9, 'TIM12_CH2_PH9': 9,

        // TIM13 — AF9
        'TIM13_CH1_PA6': 9, 'TIM13_CH1_PF8': 9,

        // TIM14 — AF9
        'TIM14_CH1_PA7': 9, 'TIM14_CH1_PF9': 9,

        // USART1 — AF7
        'USART1_TX_PA9': 7, 'USART1_TX_PB6': 7,
        'USART1_RX_PA10': 7, 'USART1_RX_PB7': 7,

        // USART2 — AF7
        'USART2_TX_PA2': 7, 'USART2_TX_PD5': 7,
        'USART2_RX_PA3': 7, 'USART2_RX_PD6': 7,

        // USART3 — AF7
        'USART3_TX_PB10': 7, 'USART3_TX_PC10': 7, 'USART3_TX_PD8': 7,
        'USART3_RX_PB11': 7, 'USART3_RX_PC11': 7, 'USART3_RX_PD9': 7,

        // UART4 — AF8
        'UART4_TX_PA0': 8, 'UART4_TX_PC10': 8,
        'UART4_RX_PA1': 8, 'UART4_RX_PC11': 8,

        // UART5 — AF8
        'UART5_TX_PC12': 8,
        'UART5_RX_PD2': 8,

        // USART6 — AF8
        'USART6_TX_PC6': 8, 'USART6_TX_PG14': 8,
        'USART6_RX_PC7': 8, 'USART6_RX_PG9': 8,

        // CAN1 — AF9
        'CAN1_TX_PA12': 9, 'CAN1_TX_PB9': 9, 'CAN1_TX_PD1': 9,
        'CAN1_RX_PA11': 9, 'CAN1_RX_PB8': 9, 'CAN1_RX_PD0': 9,

        // CAN2 — AF9
        'CAN2_TX_PB6': 9, 'CAN2_TX_PB13': 9,
        'CAN2_RX_PB5': 9, 'CAN2_RX_PB12': 9,
    },

    // Not used for F4 (legacy I2C uses CCR+TRISE, not TIMINGR)
    i2cTimingr: {},
};

// ─── STM32F1 (F100, F101, F102, F103, F105, F107) ────────────────────────────
// Reference: RM0008
// GPIO: completely different from F0/F4 — uses CRL/CRH registers, no AF registers
// GPIO on APB2 bus (not AHB like F0/F4/G0)
// Legacy I2C (same as F4, CCR+TRISE)
// Blank chip: HSI = 8MHz (not 16MHz like F4)

export const STM32F1: ChipDef = {
    family: 'stm32f1',
    name: 'STM32F100/F101/F103/F105/F107',
    gpioModel: 'f1',          // special: CRL/CRH registers, no MODER/AFRL
    spiModel: 'basic',
    i2cModel: 'legacy',
    defaultClockHz: 8_000_000,  // HSI on blank chip; typically 72MHz with PLL

    gpioBase: {
        A: 0x40010800,
        B: 0x40010C00,
        C: 0x40011000,
        D: 0x40011400,
        E: 0x40011800,
        F: 0x40011C00,
        G: 0x40012000,
    },

    rcc: {
        base: 0x40021000,
        // On F1, GPIO clocks are in APB2ENR (same register as SPI1, TIM1)
        gpioEnReg: 0x40021018,    // RCC_APB2ENR
        gpioEnBit: { A: 2, B: 3, C: 4, D: 5, E: 6, F: 7, G: 8 },
        apb1EnReg: 0x4002101C,    // RCC_APB1ENR
        apb2EnReg: 0x40021018,    // RCC_APB2ENR (same as gpioEnReg)
        apb1EnBit: {
            TIM2: 0, TIM3: 1, TIM4: 2, TIM5: 3,
            TIM6: 4, TIM7: 5,
            SPI2: 14, SPI3: 15,
            USART2: 17, USART3: 18, UART4: 19, UART5: 20,
            I2C1: 21, I2C2: 22,
            CAN1: 25, CAN2: 26,
        },
        apb2EnBit: {
            AFIO: 0,
            // GPIO bits are in gpioEnBit above (A=2, B=3, ...)
            ADC1: 9, ADC2: 10,
            TIM1: 11,
            SPI1: 12,
            TIM8: 13,
            USART1: 14,
            ADC3: 15,
            TIM9: 19, TIM10: 20, TIM11: 21,
        },
    },

    peripherals: {
        SPI1: 0x40013000,  // APB2
        SPI2: 0x40003800,  // APB1
        SPI3: 0x40003C00,  // APB1
        I2C1: 0x40005400,
        I2C2: 0x40005800,
        CAN1: 0x40006400,  // APB1
        CAN2: 0x40006800,  // APB1 (F105/F107 only)
        RTC: 0x40002800,  // APB1 (backup domain)
        TIM1: 0x40012C00,  // APB2 advanced
        TIM2: 0x40000000,
        TIM3: 0x40000400,
        TIM4: 0x40000800,
        TIM5: 0x40000C00,
        TIM6: 0x40001000,
        TIM7: 0x40001400,
        TIM8: 0x40013400,  // APB2 advanced
        USART1: 0x40013800,
        USART2: 0x40004400,
        USART3: 0x40004800,
        UART4: 0x40004C00,
        UART5: 0x40005000,
        ADC1: 0x40012400,
        ADC2: 0x40012800,
        AFIO: 0x40010000,  // for pin remapping
    },

    // F1 has NO per-pin AF registers — AF is set by CRL/CRH MODE/CNF bits.
    // Default (no-remap) pin functions only; use AFIO_MAPR for remapped pins.
    pinAf: {
    // SPI1 default pins (no remap) — AF is implicit via CNF=10/11 in CRL
        'SPI1_NSS_PA4': 0,  // AF is irrelevant for F1 (encoded in CRL/CRH MODE bits)
        'SPI1_SCK_PA5': 0,
        'SPI1_MISO_PA6': 0,
        'SPI1_MOSI_PA7': 0,
        // SPI1 remap pins
        'SPI1_NSS_PA15': 0,
        'SPI1_SCK_PB3': 0,
        'SPI1_MISO_PB4': 0,
        'SPI1_MOSI_PB5': 0,
        // SPI2 (no remap)
        'SPI2_NSS_PB12': 0,
        'SPI2_SCK_PB13': 0,
        'SPI2_MISO_PB14': 0,
        'SPI2_MOSI_PB15': 0,
        // I2C1 default
        'I2C1_SCL_PB6': 0,
        'I2C1_SDA_PB7': 0,
        // I2C1 remap
        'I2C1_SCL_PB8': 0,
        'I2C1_SDA_PB9': 0,
        // I2C2 (no remap)
        'I2C2_SCL_PB10': 0,
        'I2C2_SDA_PB11': 0,
        // TIM1 default
        'TIM1_CH1_PA8': 0,
        'TIM1_CH2_PA9': 0,
        'TIM1_CH3_PA10': 0,
        'TIM1_CH4_PA11': 0,
        // TIM2 default
        'TIM2_CH1_PA0': 0,
        'TIM2_CH2_PA1': 0,
        'TIM2_CH3_PA2': 0,
        'TIM2_CH4_PA3': 0,
        // TIM3 default
        'TIM3_CH1_PA6': 0,
        'TIM3_CH2_PA7': 0,
        'TIM3_CH3_PB0': 0,
        'TIM3_CH4_PB1': 0,
        // USART1
        'USART1_TX_PA9': 0,
        'USART1_RX_PA10': 0,
        // USART2 default (PA2/PA3)
        'USART2_TX_PA2': 0,
        'USART2_RX_PA3': 0,
        // USART3 default (PB10/PB11)
        'USART3_TX_PB10': 0,
        'USART3_RX_PB11': 0,
        // CAN1 default (PA11/PA12)
        'CAN1_TX_PA12': 0,
        'CAN1_RX_PA11': 0,
        // CAN1 remap 2 (PB8/PB9)
        'CAN1_TX_PB9': 0,
        'CAN1_RX_PB8': 0,
    },

    i2cTimingr: {},  // not used on F1 (legacy I2C uses CCR+TRISE)
};

// ─── STM32F3 (F302, F303, F373) ──────────────────────────────────────────────
// Reference: RM0316 / RM0313
// GPIO base: 0x48000000 — AHB1 bus (same layout as F0/G0: MODER-based)
// Uses new I2C with TIMINGR, legacy SPI (Classic CR1-based, DFF)
// Blank chip: HSI = 8MHz

export const STM32F3: ChipDef = {
    family: 'stm32f3',
    name: 'STM32F302/F303/F373/F378',
    gpioModel: 'new',
    spiModel: 'basic',
    i2cModel: 'new',
    defaultClockHz: 8_000_000,

    gpioBase: {
        A: 0x48000000,
        B: 0x48000400,
        C: 0x48000800,
        D: 0x48000C00,
        E: 0x48001000,
        F: 0x48001400,
    },

    rcc: {
        base: 0x40021000,
        gpioEnReg: 0x40021014,  // RCC_AHBENR
        gpioEnBit: { A: 17, B: 18, C: 19, D: 20, E: 21, F: 22 },
        apb1EnReg: 0x4002101C,  // RCC_APB1ENR
        apb2EnReg: 0x40021018,  // RCC_APB2ENR
        apb1EnBit: {
            TIM2: 0, TIM3: 1, TIM4: 2,
            SPI2: 14, SPI3: 15,
            USART2: 17, USART3: 18, UART4: 19, UART5: 20,
            I2C1: 21, I2C2: 22,
            CAN1: 25,
        },
        apb2EnBit: {
            SYSCFG: 0,
            TIM1: 11, TIM8: 13,
            SPI1: 12,
            USART1: 14,
            ADC1: 9, ADC2: 10,
        },
    },

    peripherals: {
        SPI1: 0x40013000,
        SPI2: 0x40003800,
        SPI3: 0x40003C00,
        I2C1: 0x40005400,
        I2C2: 0x40005800,
        CAN1: 0x40006400,
        TIM1: 0x40012C00,
        TIM2: 0x40000000,
        TIM3: 0x40000400,
        TIM4: 0x40000800,
        TIM8: 0x40013400,
        USART1: 0x40013800,
        USART2: 0x40004400,
        USART3: 0x40004800,
        UART4: 0x40004C00,
        UART5: 0x40005000,
        ADC1: 0x50000000,
        ADC2: 0x50000100,
        RTC: 0x40002800,
    },

    pinAf: {
    // SPI1 — AF5
        'SPI1_SCK_PA5': 5, 'SPI1_SCK_PB3': 5,
        'SPI1_MISO_PA6': 5, 'SPI1_MISO_PB4': 5,
        'SPI1_MOSI_PA7': 5, 'SPI1_MOSI_PB5': 5,
        // I2C1 — AF4
        'I2C1_SCL_PB6': 4, 'I2C1_SCL_PB8': 4,
        'I2C1_SDA_PB7': 4, 'I2C1_SDA_PB9': 4,
        // USART1 — AF7
        'USART1_TX_PA9': 7, 'USART1_TX_PB6': 7,
        'USART1_RX_PA10': 7, 'USART1_RX_PB7': 7,
        // TIM1 — AF6
        'TIM1_CH1_PA8': 6,
        'TIM1_CH2_PA9': 6,
        'TIM1_CH3_PA10': 6,
        'TIM1_CH4_PA11': 6,
    },

    // TIMINGR for F3 @ 8MHz HSI
    i2cTimingr: {
        '100k': 0x10420F13,
        '400k': 0x00310309,
    },
};

// ─── STM32G4 (G431, G441, G473, G474, G483, G484, G491, G4A1) ─────────────────
// Reference: RM0440
// GPIO base: 0x48000000 — AHB2 bus (same MODER-based model as F0/F3/G0)
// Uses new I2C (TIMINGR), enhanced SPI (FIFO), HRTIM
// Blank chip: HSI = 16MHz

export const STM32G4: ChipDef = {
    family: 'stm32g4',
    name: 'STM32G431/G441/G473/G474/G483/G484/G491/G4A1',
    gpioModel: 'new',
    spiModel: 'fifo',
    i2cModel: 'new',
    defaultClockHz: 16_000_000,

    gpioBase: {
        A: 0x48000000,
        B: 0x48000400,
        C: 0x48000800,
        D: 0x48000C00,
        E: 0x48001000,
        F: 0x48001400,
        G: 0x48001800,
    },

    rcc: {
        base: 0x40021000,
        gpioEnReg: 0x4002104C,  // RCC_AHB2ENR
        gpioEnBit: { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6 },
        apb1EnReg: 0x40021058,  // RCC_APB1ENR1
        apb2EnReg: 0x40021060,  // RCC_APB2ENR
        apb1EnBit: {
            TIM2: 0, TIM3: 1, TIM4: 2, TIM5: 3,
            TIM6: 4, TIM7: 5,
            SPI2: 14, SPI3: 15,
            USART2: 17, USART3: 18, UART4: 19, UART5: 20,
            I2C1: 21, I2C2: 22, I2C3: 23,
            CAN1: 25,
        },
        apb2EnBit: {
            SYSCFG: 0,
            TIM1: 11, TIM8: 13,
            SPI1: 12,
            USART1: 14,
            ADC1: 9, ADC2: 10,
        },
    },

    peripherals: {
        SPI1: 0x40013000,
        SPI2: 0x40003800,
        SPI3: 0x40003C00,
        I2C1: 0x40005400,
        I2C2: 0x40005800,
        I2C3: 0x40007800,
        CAN1: 0x40006400,
        TIM1: 0x40012C00,
        TIM2: 0x40000000,
        TIM3: 0x40000400,
        TIM4: 0x40000800,
        TIM5: 0x40000C00,
        TIM6: 0x40001000,
        TIM7: 0x40001400,
        TIM8: 0x40013400,
        TIM15: 0x40014000,
        TIM16: 0x40014400,
        TIM17: 0x40014800,
        USART1: 0x40013800,
        USART2: 0x40004400,
        USART3: 0x40004800,
        UART4: 0x40004C00,
        UART5: 0x40005000,
        ADC1: 0x50000000,
        ADC2: 0x50000100,
        RTC: 0x40002800,
    },

    pinAf: {
    // SPI1 — AF5
        'SPI1_SCK_PA5': 5, 'SPI1_SCK_PB3': 5,
        'SPI1_MISO_PA6': 5, 'SPI1_MISO_PB4': 5,
        'SPI1_MOSI_PA7': 5, 'SPI1_MOSI_PB5': 5,
        // I2C1 — AF4
        'I2C1_SCL_PA15': 4, 'I2C1_SCL_PB8': 4,
        'I2C1_SDA_PB7': 4, 'I2C1_SDA_PB9': 4,
        // TIM1 — AF6
        'TIM1_CH1_PA8': 6, 'TIM1_CH2_PA9': 6,
        'TIM1_CH3_PA10': 6, 'TIM1_CH4_PA11': 6,
        // USART1 — AF7
        'USART1_TX_PA9': 7, 'USART1_TX_PB6': 7,
        'USART1_RX_PA10': 7, 'USART1_RX_PB7': 7,
        // CAN1 — AF9
        'CAN1_TX_PA12': 9, 'CAN1_TX_PB9': 9,
        'CAN1_RX_PA11': 9, 'CAN1_RX_PB8': 9,
    },

    // TIMINGR for G4 @ 16MHz HSI
    i2cTimingr: {
        '100k': 0x20303E5D,
        '400k': 0x2010091A,
    },
};

// ─── Chip registry ───────────────────────────────────────────────────────────

const CHIPS: Record<string, ChipDef> = {
    // STM32G0
    'stm32g0': STM32G0,
    'stm32g030': STM32G0,
    'stm32g031': STM32G0,
    'stm32g041': STM32G0,
    'stm32g070': STM32G0,
    'stm32g071': STM32G0,
    // STM32F0
    'stm32f0': STM32F0,
    'stm32f042': STM32F0,
    'stm32f030': STM32F0,
    'stm32f031': STM32F0,
    'stm32f051': STM32F0,
    'stm32f072': STM32F0,
    // STM32F3
    'stm32f3': STM32F3,
    'stm32f302': STM32F3,
    'stm32f303': STM32F3,
    'stm32f373': STM32F3,
    'stm32f378': STM32F3,
    'stm32f3x': STM32F3,  // matches OpenOCD target name 'stm32f3x.cpu'
    // STM32G4
    'stm32g4': STM32G4,
    'stm32g431': STM32G4,
    'stm32g441': STM32G4,
    'stm32g473': STM32G4,
    'stm32g474': STM32G4,
    'stm32g483': STM32G4,
    'stm32g484': STM32G4,
    'stm32g491': STM32G4,
    'stm32g4a1': STM32G4,
    // STM32F4
    'stm32f4': STM32F4,
    'stm32f405': STM32F4,
    'stm32f407': STM32F4,
    'stm32f415': STM32F4,
    'stm32f417': STM32F4,
    'stm32f427': STM32F4,
    'stm32f429': STM32F4,
    'stm32f446': STM32F4,
    'stm32f4x': STM32F4,  // matches OpenOCD target name 'stm32f4x.cpu'
    // STM32F1
    'stm32f1': STM32F1,
    'stm32f100': STM32F1,
    'stm32f101': STM32F1,
    'stm32f102': STM32F1,
    'stm32f103': STM32F1,
    'stm32f105': STM32F1,
    'stm32f107': STM32F1,
    'stm32f1x': STM32F1,  // matches OpenOCD target name 'stm32f1x.cpu'
};

/** Resolve a chip name (case-insensitive) to its ChipDef. Returns null if unknown. */
export function getChip(name: string): ChipDef | null {
    return CHIPS[name.toLowerCase()] ?? null;
}

/** List all registered chip aliases. */
export function listChips(): string[] {
    return Object.keys(CHIPS);
}

/**
 * Parse a pin string like "PA2", "PB15" into { port: 'A', pin: 2 }.
 * Returns null on invalid format.
 */
export function parsePin(pinStr: string): { port: string; pin: number } | null {
    const m = pinStr.trim().match(/^P([A-Ia-i])(\d{1,2})$/);
    if (!m) return null;
    const pin = parseInt(m[2]);
    if (pin > 15) return null;
    return { port: m[1].toUpperCase(), pin };
}

/**
 * Look up the alternate function number for a given peripheral signal on a pin.
 * Example: lookupAF(STM32G0, 'SPI1', 'SCK', 'PB3') → 0
 */
export function lookupAF(chip: ChipDef, periph: string, signal: string, pinStr: string): number | null {
    const key = `${periph}_${signal}_${pinStr.toUpperCase()}`;
    const af = chip.pinAf[key];
    return af !== undefined ? af : null;
}

/**
 * Return all valid pins for a peripheral signal on the given chip.
 * Example: validPinsForSignal(STM32F4, 'TIM9', 'CH1') → ['PA2', 'PE5']
 */
export function validPinsForSignal(chip: ChipDef, periph: string, signal: string): string[] {
    const prefix = `${periph}_${signal}_`;
    return Object.keys(chip.pinAf)
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length))
        .sort();
}

/** Compute the GPIO base address for the given port letter on the given chip. */
export function gpioBase(chip: ChipDef, port: string): number | null {
    return chip.gpioBase[port.toUpperCase()] ?? null;
}

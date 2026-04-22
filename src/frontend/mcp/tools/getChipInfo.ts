import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openocdSend, mdwOne } from '../peripherals/openocdLow';
import { listChips } from '../peripherals/chipMap';

/**
 * Returns the connected STM32 chip family and state by querying OpenOCD.
 * Reads the OpenOCD target name (from `targets` command) and the DBGMCU_IDCODE
 * register to identify the exact device.
 */
export function registerGetChipInfo(server: McpServer) {
    server.tool(
        'get_chip_info',
        'Detects the connected STM32 chip family from OpenOCD. '
    + 'Returns the target name, state (halted/running), and device ID code. '
    + 'Use the returned chip family name (e.g. "stm32g0", "stm32f0") in other tools '
    + 'like init_peripheral, spi_transfer, i2c_transaction. '
    + 'Requires an active OpenOCD session on telnet port 50002.',
        {},
        async () => {
            try {
                // Query target list from OpenOCD
                const targetsOutput = await openocdSend('targets');

                // Parse target name and state from output like:
                // "    TargetName  Type  Endian  TapName  State"
                // " 0* stm32g0x.cpu  cortex_m  little  ...  halted"
                let family = 'unknown';
                let state = 'unknown';
                let targetName = 'unknown';

                const lines = targetsOutput.split(/\r?\n/);
                for (const line of lines) {
                    const m = line.match(/^\s*\d+\*?\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+(\S+)/);
                    if (m) {
                        targetName = m[1];
                        state = m[3];
                        // Derive family from target name
                        // Match most specific family first (f4x before f4, f1x before f1, etc.)
                        if (targetName.includes('stm32g0')) family = 'stm32g0';
                        else if (targetName.includes('stm32g4')) family = 'stm32g4';
                        else if (targetName.includes('stm32f0')) family = 'stm32f0';
                        else if (targetName.includes('stm32f1') || targetName.includes('stm32f1x')) family = 'stm32f1';
                        else if (targetName.includes('stm32f2')) family = 'stm32f2';
                        else if (targetName.includes('stm32f3')) family = 'stm32f3';
                        else if (targetName.includes('stm32f4') || targetName.includes('stm32f4x')) family = 'stm32f4';
                        else if (targetName.includes('stm32f7')) family = 'stm32f7';
                        else if (targetName.includes('stm32h7')) family = 'stm32h7';
                        else if (targetName.includes('stm32l0')) family = 'stm32l0';
                        else if (targetName.includes('stm32l4')) family = 'stm32l4';
                        else if (targetName.includes('stm32')) family = 'stm32';
                        break;
                    }
                }

                // Read DBGMCU_IDCODE (at 0xE0042000 on most Cortex-M).
                // Lower 12 bits = DEV_ID, upper 16 bits = REV_ID
                let devIdCode: number | null = null;
                let devId = 'unknown';
                try {
                    devIdCode = await mdwOne(0xE0042000);
                    const devIdNum = devIdCode & 0xFFF;
                    devId = `0x${devIdNum.toString(16).padStart(3, '0')}`;

                    // Known DEV_ID values
                    const DEV_IDS: Record<number, string> = {
                        0x467: 'STM32G030/G031/G041',
                        0x460: 'STM32G070/G071/G081',
                        0x440: 'STM32F030x8/F05x',
                        0x442: 'STM32F030xC/F09x',
                        0x444: 'STM32F030x4/x6',
                        0x445: 'STM32F042',
                        0x448: 'STM32F072/F078',
                        0x432: 'STM32F373/F378',
                        0x422: 'STM32F303',
                        0x413: 'STM32F407/F417',
                        0x419: 'STM32F427/F437',
                        0x423: 'STM32F401xB/C',
                        0x433: 'STM32F401xD/E',
                        0x458: 'STM32F410',
                        0x431: 'STM32F411',
                        0x441: 'STM32F412',
                        0x449: 'STM32F746/F756',
                        0x451: 'STM32F76x/F77x',
                        0x461: 'STM32L496/L4A6',
                    };
                    const known = DEV_IDS[devIdNum];
                    if (known) devId += ` (${known})`;
                } catch {
                    // DBGMCU not accessible (target running without SWD debug access)
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            targetName,
                            family,
                            state,
                            devIdCode: devIdCode !== null ? `0x${devIdCode.toString(16).padStart(8, '0')}` : null,
                            devId,
                            supportedFamilies: listChips().filter((k) => !k.includes('stm32g0') || k === 'stm32g0')
                                .filter((v, i, a) => a.indexOf(v) === i),
                            hint: family !== 'unknown'
                                ? `Use chip="${family}" in init_peripheral, spi_transfer, i2c_transaction`
                                : 'Family not detected — specify chip manually in other tools',
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

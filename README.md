# Cortex-Debug AI Bridge

Extensão unificada para depuração de microcontroladores ARM Cortex-M com suporte a **testes interativos de periféricos** e **servidor MCP** para integração com agentes de IA.

Baseada no [Cortex-Debug](https://github.com/Marus/cortex-debug) de Marcel Ball, com funcionalidades adicionais desenvolvidas por Paulo Palaoro (Alfatronic).

---

## Funcionalidades

### Depuração ARM Cortex-M (Cortex-Debug original)
- Suporte a J-Link, OpenOCD, ST-Link GDB Server, pyOCD e Black Magic Probe
- Visualização de registradores Cortex Core, periféricos SVD, memória
- SWO Decoding, Live Watch, RTOS Thread Support
- Múltiplas sessões e multi-core

### Peripheral Tester
Painel gráfico para testar periféricos STM32 **sem escrever firmware** — diretamente pelo OpenOCD via telnet.

**Como abrir:**
1. Inicie uma sessão de debug (OpenOCD deve estar rodando)
2. Use o comando `Cortex-Debug: Open Peripheral Tester` na paleta de comandos (`Ctrl+Shift+P`)
3. Clique **Detect chip** para identificar o microcontrolador conectado

**Periféricos suportados:**

| Aba | O que faz |
|-----|-----------|
| **GPIO** | Configura pino como saída/entrada, lê IDR, seta/reseta |
| **SPI** | Inicializa SPI1–SPI4, envia/recebe bytes (ex: JEDEC ID de flash) |
| **I2C** | Inicializa I2C1/I2C2, envia/lê registradores (ex: MPU-6050 WHO_AM_I) |
| **PWM** | Configura timer (TIM1–TIM17), canal, frequência e duty cycle |
| **CAN** | Inicializa bxCAN com bit timing, configura filtros/máscaras |
| **USART** | Inicializa UART, envia bytes, lê status |
| **Reg R/W** | Lê ou escreve qualquer registrador de periférico pelo nome |
| **RTC** | Lê hora/data, lê/escreve registradores de backup |
| **Debug** | Halt, resume, reset e erase flash do target |

**Chips suportados:** STM32F0, STM32F1, STM32F4 (F405/F407/F427/F429/F446), STM32G0

---

### Peripheral Tester — Exemplos de uso

#### Identificar memória SPI W25Q64
1. Aba **SPI** → preencha SPI3, SCK=PC10, MISO=PC11, MOSI=PC12, CS=PB8
2. Clique **Init SPI**
3. TX bytes: `0x9F 0x00 0x00 0x00` → **Transfer**
4. Resposta bytes 2–4: `EF 40 17` = W25Q64 ✓

#### Ler MPU-6050 via I2C
1. Aba **I2C** → I2C1, SCL=PB6, SDA=PB7 → **Init I2C**
2. Address: `68`, Write: `0x6B 0x00` (wake up), Read: 0 → **Send/Receive**
3. Write: `0x3B`, Read: `14` → **Send/Receive** (lê accel+gyro)

#### Configurar filtro CAN
1. Aba **CAN** → configure bit timing → **Init CAN**
2. Seção **Configure Filter** → clique **Accept All** para aceitar todos os frames
3. Ou defina ID e Mask específicos → **Set Filter**

---

### Servidor MCP (Model Context Protocol)

Servidor HTTP/SSE que expõe ferramentas de debug para agentes de IA (Claude, Copilot, etc.).

**Configuração no projeto** (`.mcp.json`):
```json
{
  "mcpServers": {
    "cortex-debug": {
      "type": "sse",
      "url": "http://localhost:7580/sse"
    }
  }
}
```

**Comandos disponíveis:**
- `Cortex-Debug: Start MCP Server`
- `Cortex-Debug: Stop MCP Server`
- `Cortex-Debug: Show MCP Status`
- `Cortex-Debug: Copy MCP Config`

**Configurações** (`settings.json`):
```json
{
  "cortex-debug.mcpPort": 7580,
  "cortex-debug.mcpAutoStart": true
}
```

---

## Requisitos

- ARM GCC Toolchain (`arm-none-eabi-gdb`)
- OpenOCD (recomendado: xPack OpenOCD via PlatformIO)
- ST-Link ou J-Link conectado ao target

## Instalação

Instale o `.vsix` diretamente no VS Code:
```
Extensions → ... → Install from VSIX
```

Ou via linha de comando:
```
code --install-extension cortex-debug-0.0.1.vsix
```

---

## Créditos

- **Cortex-Debug** original: [Marcel Ball](https://github.com/Marus/cortex-debug) — MIT License
- **AI Bridge / Peripheral Tester**: Paulo Palaoro — [Alfatronic Automação](https://alfatronic.com.br)

## Licença

MIT — veja [LICENSE](LICENSE)

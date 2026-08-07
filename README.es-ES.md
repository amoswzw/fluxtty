

# fluxtty

<p align="center">
  <img src="src-tauri/icons/icon.png" width="112" height="112" alt="fluxtty" />
</p>

<h3 align="center">Un espacio de trabajo de terminal modal estilo vim para el desarrollo con IA.</h3>

<p align="center">
  Ya no solo escribes código — diriges agentes.<br/>
  fluxtty es un espacio de trabajo controlado por teclado para ejecutar muchas sesiones de IA en paralelo,<br/>
  con la eficiencia modal que hizo indispensable a vim.
</p>

<p align="center">
  <a href="https://github.com/amoswzw/fluxtty/actions/workflows/ci.yml"><img src="https://github.com/amoswzw/fluxtty/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/amoswzw/fluxtty/actions/workflows/codeql.yml"><img src="https://github.com/amoswzw/fluxtty/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <a href="https://github.com/amoswzw/fluxtty/releases/latest"><img src="https://img.shields.io/github/v/release/amoswzw/fluxtty" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-2f363d" alt="Platform" />
  <img src="https://img.shields.io/badge/Tauri-2.x-24b47e" alt="Tauri" />
  <img src="https://img.shields.io/badge/license-MIT-4f8cff" alt="License" />
</p>

<p align="center">
  <a href="https://amoswzw.github.io/fluxtty/"><strong>Demo en vivo →</strong></a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://github.com/amoswzw/fluxtty/releases/latest"><strong>Descargar la última versión</strong></a>
</p>

<p align="center">
  <img src="docs/fluxtty-preview.gif" width="100%" alt="fluxtty workspace preview" />
</p>

## La idea

Cuando la IA escribe el código, tu trabajo cambia de teclear a dirigir. Necesitas un espacio de trabajo diseñado para eso, no un editor con una terminal añadida a posteriori.

| Antes | Ahora |
| --- | --- |
| Escribir código manualmente en un editor. | Los agentes escriben; tú revisas, diriges y desbloqueas. |
| Una terminal para comandos ocasionales. | 8–12 sesiones abiertas en paralelo: agentes, servidores, shells. |
| Ejecutar pruebas tú mismo, leer la salida y parchear manualmente. | Monitorear salidas, redirigir agentes y corregir el rumbo rápidamente. |
| Cambiar de contexto entre editor, navegador y terminal. | La terminal es todo el espacio de trabajo. |

fluxtty aplica la filosofía modal de vim a todo el espacio de trabajo de la terminal:

| Necesidad | Respuesta de fluxtty |
| --- | --- |
| Observar muchas sesiones a la vez | Las filas en cascada mantienen todos los agentes visibles sin comprimirse en una cuadrícula minúscula |
| Moverse sin tocar el ratón | Modo Normal: navegación con `h j k l`, búsqueda difusa con `/`, `n` para nuevo, `s` para dividir, `q` para cerrar |
| Escribir de forma segura en cualquier shell | El modo Inserción enruta la entrada al PTY activo; el modo Normal nunca filtra teclas hacia un agente en ejecución |
| Usar aplicaciones reales de terminal | El modo Terminal otorga control de teclado sin procesar a xterm.js para vim, htop, TUIs y prompts de agentes |
| Coordinar el espacio de trabajo | La IA del espacio de trabajo puede ejecutar, leer, crear, renombrar, agrupar, encadenar y despachar operaciones entre sesiones |

## Instalación

### Homebrew en macOS

```bash
brew tap amoswzw/tap
brew install --cask fluxtty
```

### Descarga

**[Última versión](https://github.com/amoswzw/fluxtty/releases/latest)** — macOS, Linux, Windows

| Plataforma | Paquete |
| --- | --- |
| macOS Apple Silicon | `fluxtty_*_aarch64.dmg` |
| macOS Intel | `fluxtty_*_x64.dmg` |
| Linux | `fluxtty_*_amd64.deb`, `.rpm`, `.AppImage` |
| Windows | `fluxtty_*_x64-setup.exe` |

### Compilar desde el código fuente

Prerrequisitos: [Rust](https://rustup.rs/) 1.77+, [Node.js](https://nodejs.org/) 18+, [prerrequisitos de Tauri v2](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/amoswzw/fluxtty
cd fluxtty
npm install
npm run tauri build
```

```bash
npm run tauri dev   # desarrollo
```

## Modos

fluxtty tiene una barra de entrada persistente con un pequeño conjunto de modos explícitos:

| Modo | Entrar | Qué sucede |
| --- | --- | --- |
| **Normal** | predeterminado | Navegar entre paneles y filas, desplazarse por la salida, dividir, cerrar, renombrar y buscar. Ninguna tecla alcanza el shell. |
| **Inserción** | `i` | Escribir en el shell activo a través de la barra de entrada. `Esc` regresa al modo Normal. |
| **IA** | `a` | Acceder al prompt de la IA del espacio de trabajo. Analizador integrado con `model: none`; respaldado por LLM con cualquier proveedor configurado. |
| **Terminal** | `Ctrl+\` | Entrada de terminal sin procesar. xterm.js controla el teclado hasta que `Ctrl+\` regresa al modo Normal. |
| **Buscar** | `/` | Búsqueda difusa en todos los paneles por nombre, grupo, cwd y estado. |
| **Vista** | `v` | Aislar la fila activa para observación concentrada. |

`:` en modo Normal abre la misma ruta de comandos del espacio de trabajo en línea.

## Comandos del espacio de trabajo

Comandos integrados disponibles cuando `workspace_ai.model: none`:

```text
run <cmd> in <session>
run <cmd> in group <group>
<cmd> in all sessions
run X then run Y in <session>
new [name] [in <group>]
rename <session> to <name>
close <session> | close idle | close group <group>
split
focus <session>
group <session> as <group>
note <session> <text>
read <session>
clear <session>
kill <session>
list | status | help
!agent <claude|codex|aider|gemini|opencode|goose|cursor|qwen|amp|crush|openhands|none>
```

`list`, `status`, `help`, `read`, `focus` y `!agent` se ejecutan de inmediato. Todos los comandos que modifican el espacio de trabajo se encolan a través de un paso de confirmación de plan antes de ejecutarse.

## Características destacadas

### Diseño en cascada

Las filas se apilan verticalmente; las divisiones horizontales viven dentro de una fila. Con pocas filas, fluxtty divide el espacio uniformemente. Con muchas filas, cada fila se convierte en una porción del espacio de trabajo de altura completa por la que te desplazas.

### Detección y finalización de agentes

Agentes detectados: `claude`, `codex`, `aider`, `gemini`, `opencode`, `goose`, `cursor`, `qwen`, `amp`, `crush`, `openhands`. Cuando un panel está ejecutando un agente, el indicador de modo lo refleja y Tab cambia a las finalizaciones de comandos con slash de ese agente.

### Identidad de sesión y nombrado automático

Cada panel rastrea nombre, grupo, cwd, estado, último comando, código de salida, sesión de tmux, estado de pantalla alternativa y tipo de agente. Los nuevos paneles se nombran según el cwd y luego se renombran automáticamente cuando comandos importantes toman el control. Los renombramientos manuales permanecen fijos.

### Notas de fila

`m` abre un panel de notas para la fila activa: nombres de rama, recordatorios de revisión, intención del agente. Las notas se incluyen en las instantáneas de restauración del espacio de trabajo.

### Configuración con recarga en caliente

`~/.config/fluxtty/config.yaml` se recarga en caliente al guardar. Cubre ventana, fuente, colores, cursor, shell, tmux, atajos de teclado, comportamiento de entrada, proveedor y modelo de la IA del espacio de trabajo, dimensiones en cascada, persistencia y valores predeterminados de sesión.

## Configuración

```yaml
# ~/.config/fluxtty/config.yaml

font:
  family: "JetBrains Mono"
  size: 13.0

colors:
  primary:
    background: "#0d1117"
    foreground: "#e6edf3"

input:
  live_typing: true

workspace_ai:
  model: none                    # or: claude-sonnet-4-6, gpt-4o, gemini-2.0-flash, ollama/llama3
  always_confirm_broadcast: true
  always_confirm_multi_step: true

waterfall:
  row_height_mode: viewport
  scroll_snap: false
```

## Atajos de teclado

| Tecla | Modo | Acción |
| --- | --- | --- |
| `h` `j` `k` `l` | Normal | Moverse entre paneles y filas |
| `i` | Normal, Vista | Modo de inserción para el PTY activo |
| `a` o `:` | Normal | IA del espacio de trabajo / prompt de comandos |
| `/` | Normal | Selector difuso de paneles |
| `v` | Normal | Modo de vista para la fila activa |
| `n` | Normal | Nueva fila de terminal |
| `s` | Normal | Dividir la fila activa |
| `q` | Normal | Cerrar el panel activo |
| `m` | Normal | Alternar el panel de notas de fila |
| `r` | Normal | Renombrar el panel activo |
| `G` / `gg` | Normal | Saltar al final / principio del espacio de trabajo |
| `Ctrl+\` | Cualquiera | Alternar modo Terminal sin procesar |
| `Esc` | Inserción, IA, Buscar, Vista | Regresar al modo Normal |
| `Tab` | Inserción | Finalización del shell o de comandos con slash del agente |
| `Cmd+,` / `Ctrl+,` | Cualquiera | Abrir configuración |

## Desarrollo

```bash
npm install
npm run tauri dev    # desarrollo con recarga en caliente
npm test
npm run build
npm run tauri build  # paquete de producción
```

## Contribuir

Los issues y pull requests son bienvenidos. Mantén los cambios enfocados, ejecuta el conjunto de pruebas e incluye capturas de pantalla o grabaciones para cambios en el comportamiento de la interfaz.

## Inspiración

La idea del diseño en cascada — terminales apilados verticalmente que llenan el área de visualización a medida que te desplazas — fue descaradamente robada a [`infinite-scroll`](https://github.com/gaojude/infinite-scroll). Prefiero la palabra "inspirado".

---

## Licencia

MIT

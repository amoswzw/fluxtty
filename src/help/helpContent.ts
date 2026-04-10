export interface QuickStartStep {
  id: string;
  title: string;
  summary: string;
  detail: string;
  shortcuts: string[];
  accent: 'blue' | 'green' | 'cyan' | 'yellow' | 'magenta';
}

export interface CheatSheetSection {
  title: string;
  summary: string;
  items: Array<{
    shortcuts: string[];
    description: string;
  }>;
}

export function getWorkspaceModifierLabel(modifier: string | null | undefined): string | null {
  switch ((modifier ?? 'meta').toLowerCase()) {
    case 'meta':
      return 'Command';
    case 'control':
      return 'Control';
    case 'alt':
      return 'Option / Alt';
    case 'shift':
      return 'Shift';
    case 'disabled':
      return null;
    default:
      return 'Command';
  }
}

export function getSettingsShortcutLabel(isMac: boolean): string {
  return isMac ? 'Cmd+,' : 'Ctrl+,';
}

export function getNormalShortcutsHintText(): string {
  return 'Normal mode: `H` `J` `K` `L` or arrow keys move · `N` new terminal · `S` split · `Q` close · `R` rename · `M` note';
}

export function getTerminalToggleHintText(): string {
  return 'Press `Ctrl+\\` to enter raw terminal input; press it again to return to `Normal`';
}

export function getWorkspaceScrollHintText(modifierLabel: string | null): string | null {
  if (!modifierLabel) return null;
  return `Hold \`${modifierLabel} + Wheel\` to scroll the workspace; the pane under the pointer becomes active`;
}

export function getQuickStartSteps(options: {
  workspaceModifierLabel: string | null;
}): QuickStartStep[] {
  const workspaceStepSummary = options.workspaceModifierLabel
    ? `Hold \`${options.workspaceModifierLabel} + Wheel\` to scroll the workspace instead of the terminal scrollback.`
    : 'Workspace scrolling by modifier is currently disabled. You can enable it in Settings > Terminal > Input.';
  const workspaceStepDetail = options.workspaceModifierLabel
    ? 'The pane under the pointer becomes active, so you can browse the waterfall without changing focus first.'
    : 'Plain wheel scrolling still works inside terminals and notes; only the modifier-based workspace scroll is disabled.';

  return [
    {
      id: 'new-terminal',
      title: 'Create a terminal',
      summary: 'Press `N` to open a new terminal in a new row.',
      detail: 'Fluxtty stacks rows vertically, so each new terminal drops into the waterfall as its own workspace slice.',
      shortcuts: ['N'],
      accent: 'blue',
    },
    {
      id: 'split-row',
      title: 'Split the active row',
      summary: 'Press `S` to split the current row into another pane.',
      detail: 'Use split when two terminals belong together and should stay side-by-side inside the same row.',
      shortcuts: ['S'],
      accent: 'magenta',
    },
    {
      id: 'move',
      title: 'Move without the mouse',
      summary: 'Use `H` `J` `K` `L` or the arrow keys to move across panes and rows.',
      detail: '`H` / `←` and `L` / `→` move sideways. `J` / `↓` and `K` / `↑` move between rows, keeping the closest horizontal match when possible.',
      shortcuts: ['H', 'J', 'K', 'L', 'Arrow Keys'],
      accent: 'blue',
    },
    {
      id: 'modes',
      title: 'Enter and leave Insert',
      summary: 'Press `I`, type `ls`, press `Enter`, then press `Esc` to return to `Normal`.',
      detail: 'Insert mode keeps typing in the input bar while the command is sent into the active terminal, so you can see both the input path and the shell result.',
      shortcuts: ['I', 'ls', 'Enter', 'Esc'],
      accent: 'green',
    },
    {
      id: 'terminal-toggle',
      title: 'Use raw terminal input',
      summary: 'Press `Ctrl+\\` to enter raw terminal mode, then press it again to return to `Normal`.',
      detail: 'Raw terminal mode sends keys straight to the shell. It is useful for full-screen TUIs or when you want zero input-bar mediation.',
      shortcuts: ['Ctrl+\\'],
      accent: 'cyan',
    },
    {
      id: 'scroll',
      title: 'Scroll the workspace',
      summary: workspaceStepSummary,
      detail: workspaceStepDetail,
      shortcuts: options.workspaceModifierLabel ? [`${options.workspaceModifierLabel} + Wheel`] : ['Disabled'],
      accent: 'yellow',
    },
  ];
}

export function getCheatSheetSections(options: {
  isMac: boolean;
  workspaceModifierLabel: string | null;
}): CheatSheetSection[] {
  const workspaceSummary = options.workspaceModifierLabel
    ? `Hold ${options.workspaceModifierLabel} while scrolling to move through the waterfall.`
    : 'Workspace scroll modifier is currently disabled.';
  const appItems: CheatSheetSection['items'] = [
    { shortcuts: [getSettingsShortcutLabel(options.isMac)], description: 'Open Settings' },
  ];
  if (options.isMac) {
    appItems.push(
      { shortcuts: ['Cmd+W'], description: 'Close the active pane' },
      { shortcuts: ['Cmd+Q'], description: 'Quit fluxtty' },
    );
  }

  return [
    {
      title: 'Normal',
      summary: 'Navigation and workspace control.',
      items: [
        { shortcuts: ['H', 'J', 'K', 'L'], description: 'Move left, down, up, and right across panes and rows' },
        { shortcuts: ['←', '↓', '↑', '→'], description: 'Arrow keys also move across panes and rows in Normal mode' },
        { shortcuts: ['N'], description: 'Create a new terminal in a new row' },
        { shortcuts: ['S'], description: 'Split the active row into another pane' },
        { shortcuts: ['Q'], description: 'Close the active pane' },
        { shortcuts: ['R'], description: 'Rename the active pane' },
        { shortcuts: ['M'], description: 'Open or focus the row note' },
        { shortcuts: ['/'], description: 'Open pane selector' },
        { shortcuts: [':'], description: 'Open command line / AI prompt' },
        { shortcuts: ['A'], description: 'Enter AI mode' },
        { shortcuts: ['I'], description: 'Enter Insert mode' },
      ],
    },
    {
      title: 'Insert & Terminal',
      summary: 'How typing reaches the shell.',
      items: [
        { shortcuts: ['I'], description: 'Enter Insert mode, type in the input bar, and press Enter to send the line to the active terminal' },
        { shortcuts: ['Esc'], description: 'Return to Normal mode from Insert or AI' },
        { shortcuts: ['Ctrl+\\'], description: 'Enter raw terminal input; press again to return to Normal' },
        { shortcuts: ['Ctrl+C'], description: 'Interrupt the running process in the active terminal' },
      ],
    },
    {
      title: 'Workspace',
      summary: workspaceSummary,
      items: [
        { shortcuts: options.workspaceModifierLabel ? [`${options.workspaceModifierLabel} + Wheel`] : ['Disabled'], description: options.workspaceModifierLabel ? 'Scroll the workspace and activate the pane under the pointer' : 'Enable a modifier in Settings > Terminal > Input' },
        { shortcuts: ['W'], description: 'Move to the next pane in the current row' },
        { shortcuts: ['Shift+W'], description: 'Move to the previous pane in the current row' },
        { shortcuts: ['Ctrl+D', 'Ctrl+U'], description: 'Scroll the active terminal by half a page in Normal mode' },
        { shortcuts: ['Ctrl+F', 'Ctrl+B'], description: 'Scroll the active terminal by a full page in Normal mode' },
        { shortcuts: ['G', 'GG'], description: 'Jump to the bottom or top of the workspace' },
      ],
    },
    {
      title: 'App',
      summary: 'Global controls while this app window is focused.',
      items: appItems,
    },
  ];
}

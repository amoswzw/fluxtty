import type { PaneInfo } from './types';
import { isSignificantCommand, nameFromCwd, suggestName } from './AutoNamer';

export function canAutoRenamePane(pane: PaneInfo): boolean {
  return pane.name_source === 'auto';
}

export function suggestCwdNameForPane(pane: PaneInfo): string | null {
  if (!canAutoRenamePane(pane)) return null;
  const nextName = nameFromCwd(pane.cwd);
  return nextName && nextName !== pane.name ? nextName : null;
}

export function suggestCommandNameForPane(pane: PaneInfo, command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || !isSignificantCommand(trimmed) || !canAutoRenamePane(pane)) return null;
  const nextName = suggestName(trimmed, pane.cwd);
  return nextName && nextName !== pane.name ? nextName : null;
}

/**
 * Suggest a name when a pane enters alternate screen mode.
 * This catches any TUI app not in the SIGNIFICANT list — the rename fires
 * once the app actually takes over the screen, using last_command as the source.
 */
export function suggestAltScreenNameForPane(pane: PaneInfo): string | null {
  if (!canAutoRenamePane(pane) || !pane.last_command) return null;
  const nextName = suggestName(pane.last_command, pane.cwd);
  return nextName && nextName !== pane.name ? nextName : null;
}

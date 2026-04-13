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

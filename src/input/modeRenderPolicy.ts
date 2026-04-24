import type { InputMode } from '../session/types';

export function modeClearsInputValueOnRender(modeType: InputMode['type']): boolean {
  return modeType === 'normal'
    || modeType === 'view'
    || modeType === 'terminal'
    || modeType === 'pane-search';
}

export interface ShellLineState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  killBuffer: string;
}

function clampSelection(value: string, pos: number): number {
  return Math.max(0, Math.min(value.length, pos));
}

function normalizeState(state: ShellLineState): ShellLineState {
  const start = clampSelection(state.value, state.selectionStart);
  const end = clampSelection(state.value, state.selectionEnd);
  return {
    value: state.value,
    selectionStart: Math.min(start, end),
    selectionEnd: Math.max(start, end),
    killBuffer: state.killBuffer,
  };
}

function hasSelection(state: ShellLineState): boolean {
  return state.selectionStart !== state.selectionEnd;
}

function replaceRange(
  state: ShellLineState,
  start: number,
  end: number,
  text: string,
  killBuffer = state.killBuffer,
): ShellLineState {
  const value = state.value.slice(0, start) + text + state.value.slice(end);
  const cursor = start + text.length;
  return {
    value,
    selectionStart: cursor,
    selectionEnd: cursor,
    killBuffer,
  };
}

function backwardShellWordStart(value: string, cursor: number): number {
  let pos = cursor;
  while (pos > 0 && /\s/.test(value[pos - 1])) pos--;
  while (pos > 0 && !/\s/.test(value[pos - 1])) pos--;
  return pos;
}

function forwardShellWordEnd(value: string, cursor: number): number {
  let pos = cursor;
  while (pos < value.length && /\s/.test(value[pos])) pos++;
  while (pos < value.length && !/\s/.test(value[pos])) pos++;
  return pos;
}

export function moveCursorLineStart(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  return { ...next, selectionStart: 0, selectionEnd: 0 };
}

export function moveCursorLineEnd(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  return {
    ...next,
    selectionStart: next.value.length,
    selectionEnd: next.value.length,
  };
}

export function moveCursorLeft(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  const cursor = hasSelection(next)
    ? next.selectionStart
    : Math.max(0, next.selectionStart - 1);
  return { ...next, selectionStart: cursor, selectionEnd: cursor };
}

export function moveCursorRight(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  const cursor = hasSelection(next)
    ? next.selectionEnd
    : Math.min(next.value.length, next.selectionEnd + 1);
  return { ...next, selectionStart: cursor, selectionEnd: cursor };
}

export function moveCursorBackwardWord(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  const cursor = hasSelection(next)
    ? next.selectionStart
    : backwardShellWordStart(next.value, next.selectionStart);
  return { ...next, selectionStart: cursor, selectionEnd: cursor };
}

export function moveCursorForwardWord(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  const cursor = hasSelection(next)
    ? next.selectionEnd
    : forwardShellWordEnd(next.value, next.selectionEnd);
  return { ...next, selectionStart: cursor, selectionEnd: cursor };
}

export function deleteBackwardShellWord(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  if (hasSelection(next)) {
    return replaceRange(next, next.selectionStart, next.selectionEnd, '', next.value.slice(next.selectionStart, next.selectionEnd));
  }
  const start = backwardShellWordStart(next.value, next.selectionStart);
  if (start === next.selectionStart) return next;
  return replaceRange(next, start, next.selectionStart, '', next.value.slice(start, next.selectionStart));
}

export function deleteForwardShellWord(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  if (hasSelection(next)) {
    return replaceRange(next, next.selectionStart, next.selectionEnd, '', next.value.slice(next.selectionStart, next.selectionEnd));
  }
  const end = forwardShellWordEnd(next.value, next.selectionEnd);
  if (end === next.selectionEnd) return next;
  return replaceRange(next, next.selectionStart, end, '', next.value.slice(next.selectionStart, end));
}

export function deleteBackwardToLineStart(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  if (hasSelection(next)) {
    return replaceRange(next, next.selectionStart, next.selectionEnd, '', next.value.slice(next.selectionStart, next.selectionEnd));
  }
  if (next.selectionStart === 0) return next;
  return replaceRange(next, 0, next.selectionStart, '', next.value.slice(0, next.selectionStart));
}

export function deleteForwardToLineEnd(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  if (hasSelection(next)) {
    return replaceRange(next, next.selectionStart, next.selectionEnd, '', next.value.slice(next.selectionStart, next.selectionEnd));
  }
  if (next.selectionEnd >= next.value.length) return next;
  return replaceRange(next, next.selectionStart, next.value.length, '', next.value.slice(next.selectionStart));
}

export function deleteForwardChar(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  if (hasSelection(next)) {
    return replaceRange(next, next.selectionStart, next.selectionEnd, '');
  }
  if (next.selectionStart >= next.value.length) return next;
  return replaceRange(next, next.selectionStart, next.selectionStart + 1, '');
}

export function deleteBackwardChar(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  if (hasSelection(next)) {
    return replaceRange(next, next.selectionStart, next.selectionEnd, '');
  }
  if (next.selectionStart === 0) return next;
  return replaceRange(next, next.selectionStart - 1, next.selectionStart, '');
}

export function transposeChars(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  if (hasSelection(next)) return next;
  if (next.value.length < 2 || next.selectionStart === 0) return next;

  const cursor = next.selectionStart;
  const left = cursor === next.value.length ? cursor - 2 : cursor - 1;
  if (left < 0 || left + 1 >= next.value.length) return next;

  const chars = next.value.split('');
  [chars[left], chars[left + 1]] = [chars[left + 1], chars[left]];
  const nextCursor = cursor === next.value.length
    ? next.value.length
    : Math.min(next.value.length, cursor + 1);

  return {
    value: chars.join(''),
    selectionStart: nextCursor,
    selectionEnd: nextCursor,
    killBuffer: next.killBuffer,
  };
}

export function yankKillBuffer(state: ShellLineState): ShellLineState {
  const next = normalizeState(state);
  if (!next.killBuffer) return next;
  return replaceRange(next, next.selectionStart, next.selectionEnd, next.killBuffer, next.killBuffer);
}

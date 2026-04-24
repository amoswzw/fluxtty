import { describe, expect, it } from 'vitest';
import {
  deleteBackwardShellWord,
  deleteForwardChar,
  deleteForwardShellWord,
  deleteForwardToLineEnd,
  moveCursorBackwardWord,
  moveCursorForwardWord,
  transposeChars,
  yankKillBuffer,
  type ShellLineState,
} from '../input/shellLineEditing';

function state(value: string, selectionStart = value.length, selectionEnd = selectionStart, killBuffer = ''): ShellLineState {
  return { value, selectionStart, selectionEnd, killBuffer };
}

describe('shellLineEditing', () => {
  it('deletes the previous shell word with Ctrl+W semantics', () => {
    expect(deleteBackwardShellWord(state('git commit')))
      .toEqual(state('git ', 4, 4, 'commit'));
    expect(deleteBackwardShellWord(state('git   commit')))
      .toEqual(state('git   ', 6, 6, 'commit'));
    expect(deleteBackwardShellWord(state('git   ')))
      .toEqual(state('', 0, 0, 'git   '));
  });

  it('deletes forward like shell Ctrl+D when buffered input is non-empty', () => {
    expect(deleteForwardChar(state('echo', 1)))
      .toEqual(state('eho', 1, 1));
    expect(deleteForwardChar(state('echo', 4)))
      .toEqual(state('echo', 4, 4));
  });

  it('supports word motions and forward word kill', () => {
    expect(moveCursorBackwardWord(state('echo hello world', 11)))
      .toEqual(state('echo hello world', 5, 5));
    expect(moveCursorForwardWord(state('echo hello world', 5)))
      .toEqual(state('echo hello world', 10, 10));
    expect(deleteForwardShellWord(state('echo hello world', 5)))
      .toEqual(state('echo  world', 5, 5, 'hello'));
  });

  it('supports line-end kill, transpose, and yank', () => {
    expect(deleteForwardToLineEnd(state('abcdef', 2)))
      .toEqual(state('ab', 2, 2, 'cdef'));
    expect(transposeChars(state('abcd', 2)))
      .toEqual(state('acbd', 3, 3));
    expect(yankKillBuffer(state('ab', 1, 1, 'XYZ')))
      .toEqual(state('aXYZb', 4, 4, 'XYZ'));
  });
});

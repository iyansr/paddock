import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('session scroll keys skip the shell', () => {
    // xterm handles Shift+PageUp itself unless the command is in this list.
    const skip = vscode.workspace.getConfiguration('terminal.integrated').inspect<string[]>('commandsToSkipShell');
    assert.deepStrictEqual(skip?.defaultValue, ['paddock.scrollPageUp', 'paddock.scrollPageDown']);
  });

  test('Sample test', () => {
    assert.strictEqual(-1, [1, 2, 3].indexOf(5));
    assert.strictEqual(-1, [1, 2, 3].indexOf(0));
  });
});

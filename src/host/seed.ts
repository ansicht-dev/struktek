/**
 * Write the starter library to disk.
 *
 * The content itself lives in `seedContent.ts` so it can be parsed in a unit
 * test without an extension host. This module is only the part that touches the
 * filesystem.
 */

import * as vscode from 'vscode';
import { log } from './log';
import { TEMPLATES_DIR } from './paths';
import { BLOCKS, TEMPLATES } from './seedContent';

export { newBlockBody, newTemplateBody } from './seedContent';

/**
 * Create the starter library if the root has no `templates/` yet.
 *
 * Returns true when files were written, so the caller can say so — seeding
 * silently would leave the user with a picker full of things they did not know
 * had appeared. Struktek never overwrites a file the user might have edited.
 */
export async function seedLibrary(root: vscode.Uri): Promise<boolean> {
  const templatesDir = vscode.Uri.joinPath(root, TEMPLATES_DIR);
  try {
    await vscode.workspace.fs.stat(templatesDir);
    return false; // Already there — leave an existing library alone.
  } catch {
    // Not there: fall through and seed.
  }

  for (const file of [...TEMPLATES, ...BLOCKS]) {
    const uri = vscode.Uri.joinPath(root, ...file.path);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(file.body, 'utf8'));
  }
  log('Seeded the starter library', {
    root: root.toString(),
    files: TEMPLATES.length + BLOCKS.length,
  });
  return true;
}

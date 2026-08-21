/**
 * "Report an issue", as two doors rather than one.
 *
 * A single link to the issue tracker lands people on a blank form, where the
 * first thing they have to decide is which kind of thing they are writing —
 * and the answer changes what we need from them. Asking here instead means the
 * form that opens is already the right one, with the version and the editor
 * filled in, which are the two facts a bug report is most often missing and
 * the reporter is least interested in going to find.
 *
 * The URL building is separate from the picker and takes everything it needs
 * as arguments, so it can be tested without a window: a link that opens the
 * wrong form is exactly the sort of thing that is invisible until someone
 * files against it.
 */

import * as vscode from 'vscode';

/** Which form to open. The values are the template filenames without `.yml`. */
export type IssueKind = 'bug_report' | 'feature_request';

/**
 * What we fill in for the reporter.
 *
 * Field names match the `id`s in `.github/ISSUE_TEMPLATE/*.yml` — that is what
 * makes GitHub prefill them, and it is the one coupling in this module. A name
 * that stops matching prefills nothing rather than breaking the link.
 */
export interface IssueContext {
  readonly version: string;
  readonly editor: string;
  readonly platform: string;
}

/**
 * The repository the extension declares it lives in.
 *
 * Read from the manifest rather than written here, so a fork is reported to
 * the fork. `repository.url` is npm-shaped — `git+https://…​.git` — and both
 * ends of that have to come off before it is a page anyone can open.
 */
export function repositoryUrl(manifest: unknown): string | undefined {
  const repository = (manifest as { repository?: unknown } | undefined)?.repository;
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof (repository as { url?: unknown } | undefined)?.url === 'string'
        ? (repository as { url: string }).url
        : undefined;
  if (raw === undefined) return undefined;
  const url = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return url.startsWith('http') ? url : undefined;
}

/** The new-issue URL for one form, with what we know already filled in. */
export function issueUrl(repository: string, kind: IssueKind, context: IssueContext): string {
  const query = new URLSearchParams({
    template: kind + '.yml',
    version: context.version,
    editor: context.editor,
    platform: context.platform,
  });
  return repository + '/issues/new?' + query.toString();
}

/**
 * Ask which kind, then open that form.
 *
 * A QuickPick rather than two buttons in the title bar: the choice is made
 * once, on the way out of the editor, and two glyphs that both mean "tell us
 * something" would be two things to tell apart every time you looked at the
 * bar. Cancelling opens nothing at all.
 */
export async function reportIssue(manifest: unknown, version: string): Promise<void> {
  const repository = repositoryUrl(manifest);
  if (!repository) {
    void vscode.window.showWarningMessage(
      'Struktek: this build does not say where its issue tracker is.',
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        // Not `kind`: QuickPickItem already owns that name, for separators.
        form: 'bug_report' as const,
        label: '$(bug) Report a Bug',
        detail: 'Something is broken, or does not do what it says',
      },
      {
        form: 'feature_request' as const,
        label: '$(lightbulb) Request a Feature',
        detail: 'Something Struktek should be able to do and cannot',
      },
    ],
    {
      title: 'Struktek - Report an Issue',
      placeHolder: 'What would you like to report?',
      matchOnDetail: true,
    },
  );
  if (!picked) return;

  await vscode.env.openExternal(
    vscode.Uri.parse(
      issueUrl(repository, picked.form, {
        version,
        // The app name matters as much as the version: struktek runs in
        // VSCodium and in Cursor too, and "it works here" often turns on which.
        editor: vscode.env.appName + ' ' + vscode.version,
        platform: process.platform + ' ' + process.arch,
      }),
    ),
  );
}

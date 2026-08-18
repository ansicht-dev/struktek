/**
 * A hand-written `vscode` stub.
 *
 * Unit tests never launch an extension host, so host modules need something to
 * import. Plain no-ops rather than `vi.fn()` everywhere: a test that cares about
 * a particular call wraps that one member itself, which keeps the shared stub
 * from accumulating assertions nobody reads.
 *
 * Only what struktek actually touches is here. Reaching for something absent
 * should fail loudly in the test that needs it, and get added deliberately.
 */

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}

  static file(path: string): Uri {
    return new Uri('file', path.replace(/\\/g, '/'));
  }

  static parse(value: string): Uri {
    const index = value.indexOf(':');
    return index === -1 ? new Uri('file', value) : new Uri(value.slice(0, index), value.slice(index + 1));
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/$/, ''), ...segments].join('/');
    return new Uri(base.scheme, joined);
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return this.scheme + '://' + this.path;
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

export class EventEmitter<T> {
  private listeners: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

const noopDisposable = { dispose: (): void => undefined };

export const window = {
  createOutputChannel: () => ({
    appendLine: (): void => undefined,
    show: (): void => undefined,
    dispose: (): void => undefined,
  }),
  showInformationMessage: async (): Promise<undefined> => undefined,
  showWarningMessage: async (): Promise<undefined> => undefined,
  showErrorMessage: async (): Promise<undefined> => undefined,
  showQuickPick: async (): Promise<undefined> => undefined,
  showInputBox: async (): Promise<undefined> => undefined,
  showTextDocument: async (): Promise<undefined> => undefined,
  activeTextEditor: undefined as unknown,
};

export const workspace = {
  workspaceFolders: undefined as unknown,
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
  onDidChangeConfiguration: () => noopDisposable,
  onDidChangeWorkspaceFolders: () => noopDisposable,
  createFileSystemWatcher: () => ({
    onDidCreate: () => noopDisposable,
    onDidChange: () => noopDisposable,
    onDidDelete: () => noopDisposable,
    dispose: (): void => undefined,
  }),
  findFiles: async (): Promise<Uri[]> => [],
  openTextDocument: async (): Promise<undefined> => undefined,
  asRelativePath: (value: unknown): string => String(value),
  fs: {
    readFile: async (): Promise<Uint8Array> => {
      throw new Error('vscode.workspace.fs.readFile is not stubbed for this test');
    },
    writeFile: async (): Promise<void> => undefined,
    readDirectory: async (): Promise<[string, FileType][]> => [],
    createDirectory: async (): Promise<void> => undefined,
    stat: async (): Promise<never> => {
      throw new Error('not found');
    },
  },
};

export const commands = {
  registerCommand: () => noopDisposable,
  executeCommand: async (): Promise<undefined> => undefined,
};

export const env = {
  clipboard: { writeText: async (): Promise<void> => undefined },
};

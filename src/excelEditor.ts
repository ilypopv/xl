import * as vscode from 'vscode';
import { Disposable, disposeAll } from './dispose';
import { Utils } from 'vscode-uri';
import ExcelDocumentView from './excelDocumentView';
import { documentViewManager } from './documentViewManager';

export class ExcelEditorProvider implements vscode.CustomEditorProvider<ExcelDocument> {
    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new ExcelEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            ExcelEditorProvider.viewType,
            provider,
            {
                webviewOptions: {
                    enableFindWidget: false,
                    retainContextWhenHidden: true
                }
            }
        );
        return providerRegistration;
    }

    private static readonly viewType = 'xl-excel-editor';

    constructor(private readonly context: vscode.ExtensionContext) {}

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
        vscode.CustomDocumentContentChangeEvent<ExcelDocument>
    >(); // CustomDocumentEditEvent
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    saveCustomDocument(document: ExcelDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return document.save(cancellation);
    }

    saveCustomDocumentAs(
        document: ExcelDocument,
        destination: vscode.Uri,
        cancellation: vscode.CancellationToken
    ): Thenable<void> {
        return document.saveAs(destination, cancellation);
    }

    revertCustomDocument(document: ExcelDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return document.revert(cancellation);
    }

    backupCustomDocument(
        document: ExcelDocument,
        context: vscode.CustomDocumentBackupContext,
        cancellation: vscode.CancellationToken
    ): Thenable<vscode.CustomDocumentBackup> {
        return document.backup(context.destination, cancellation);
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: { backupId?: string },
        _token: vscode.CancellationToken
    ): Promise<ExcelDocument> {
        const document: ExcelDocument = ExcelDocument.create(uri, openContext.backupId, {
            getFileData: async token => {
                const view =
                    document.lastView && !document.lastView.isDisposed
                        ? document.lastView
                        : <ExcelDocumentView | undefined>documentViewManager.find(document.uri, true);
                if (!view) {
                    throw new Error('The Excel editor is not open, so the current content is not available.');
                }
                return view.requestData(token);
            },
            documentSaved: target => {
                // Read-only previews of the same file read the disk; refresh them after a save.
                if (target.toString() === document.uri.toString()) {
                    for (const view of documentViewManager.filter(document.uri, false)) {
                        view.refresh();
                    }
                }
            }
        });

        const listeners: vscode.Disposable[] = [];

        listeners.push(
            document.onDidChange(e => {
                // Tell VS Code that the document has been edited by the use.
                this._onDidChangeCustomDocument.fire({
                    document,
                    ...e
                });
            })
        );

        listeners.push(
            document.onDidChangeDocument(e => {
                // Update all webviews when the document changes
                for (const view of documentViewManager.filter(document.uri)) {
                    view.panel.webview.postMessage({
                        content: e.content
                    });
                }
            })
        );

        document.onDidDispose(() => disposeAll(listeners));
        return document;
    }

    public async resolveCustomEditor(
        document: ExcelDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        let editor = new ExcelDocumentView(this.context, document.uri);
        editor.panel = webviewPanel;
        editor.enableEditing(document);
        editor.initialize();
    }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

interface ExcelDocumentDelegate {
    getFileData(token: vscode.CancellationToken): Promise<Uint8Array>;
    documentSaved(target: vscode.Uri): void;
}

export class ExcelDocument extends Disposable implements vscode.CustomDocument {
    // The file is read while the webview boots; consumers of documentData wait for `ready`.
    static create(uri: vscode.Uri, backupId: string | undefined, delegate: ExcelDocumentDelegate): ExcelDocument {
        const dataFile = typeof backupId === 'string' ? vscode.Uri.parse(backupId) : uri;
        const doc = new ExcelDocument(uri, ExcelDocument.readFile(dataFile), delegate);
        doc.restored = typeof backupId === 'string';
        return doc;
    }

    // true when the model was restored from a hot-exit backup, so the disk file is not the content to show
    public restored = false;

    private static async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        if (uri.scheme === 'untitled') {
            return new Uint8Array();
        }
        return vscode.workspace.fs.readFile(uri);
    }

    private readonly _uri: vscode.Uri;
    public get uri() {
        return this._uri;
    }

    private _documentData: Uint8Array = new Uint8Array();
    private _ready: Promise<void>;
    public get ready(): Promise<void> {
        return this._ready;
    }
    public get documentData(): Uint8Array {
        return this._documentData;
    }

    private readonly _delegate: ExcelDocumentDelegate;

    private constructor(uri: vscode.Uri, initialContent: Promise<Uint8Array>, delegate: ExcelDocumentDelegate) {
        super();
        this._uri = uri;
        this._ready = initialContent.then(data => {
            this._documentData = data;
        });
        this._ready.catch(() => undefined);
        this._delegate = delegate;
        this.watch();
    }

    private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>());
    public readonly onDidDispose = this._onDidDispose.event;

    private readonly _onDidChangeDocument = this._register(
        new vscode.EventEmitter<{
            readonly content?: Uint8Array;
        }>()
    );

    public readonly onDidChangeDocument = this._onDidChangeDocument.event;

    private readonly _onDidChange = this._register(
        new vscode.EventEmitter<{
            readonly label: string;
            undo(): void;
            redo(): void;
        }>()
    );

    public readonly onDidChange = this._onDidChange.event;

    private _lastView: ExcelDocumentView | undefined;
    public get lastView(): ExcelDocumentView | undefined {
        return this._lastView;
    }

    private _dirty = false;
    public get dirty() {
        return this._dirty;
    }

    private _watchTimer: any;
    private _warned = false;

    private watch() {
        if (this._uri.scheme === 'untitled') {
            return;
        }
        try {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(Utils.dirname(this._uri) as any, Utils.basename(this._uri))
            );
            const onDisk = () => {
                clearTimeout(this._watchTimer);
                this._watchTimer = setTimeout(() => {
                    this.diskChanged().catch(() => undefined);
                }, 300);
            };
            this._register(watcher);
            this._register(watcher.onDidChange(onDisk));
            this._register(watcher.onDidCreate(onDisk));
            this._register({ dispose: () => clearTimeout(this._watchTimer) });
        } catch {
            // no watcher support (virtual file systems)
        }
    }

    // Reloads a clean document when the file changes on disk; a dirty one only warns, it never loses edits.
    private async diskChanged() {
        await this._ready;
        const disk = await ExcelDocument.readFile(this._uri);
        if (sameBytes(disk, this._documentData)) {
            return;
        }
        if (!this._dirty) {
            this._documentData = disk;
            this._onDidChangeDocument.fire({ content: disk });
            this._delegate.documentSaved(this._uri);
            return;
        }
        if (this._warned) {
            return;
        }
        this._warned = true;
        const pick = await vscode.window.showWarningMessage(
            `'${Utils.basename(this._uri)}' changed on disk while it has unsaved edits. Saving will overwrite the disk version.`,
            'Revert to disk version'
        );
        this._warned = false;
        if (pick) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
    }

    change(label: string, view: ExcelDocumentView) {
        this._dirty = true;
        this._lastView = view;
        this._onDidChange.fire({
            label: label,
            undo: async () => view.undo(),
            redo: async () => view.redo()
        });
    }

    async save(cancellation: vscode.CancellationToken): Promise<void> {
        await this.saveAs(this.uri, cancellation);
    }

    async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        // Rejects when the webview cannot produce the bytes, so VS Code reports the failed save and keeps the document dirty.
        const fileData = await this._delegate.getFileData(cancellation);
        if (cancellation.isCancellationRequested) {
            return;
        }
        if (!fileData || fileData.length < 4) {
            throw new Error('Refusing to write an empty workbook.');
        }
        await vscode.workspace.fs.writeFile(targetResource, fileData);
        if (targetResource.toString() === this.uri.toString()) {
            this._dirty = false;
        }
        // Remember the latest working bytes: a re-created webview (or hot-exit) must not fall back to older data.
        this._documentData = fileData;
        this._delegate.documentSaved(targetResource);
    }

    async revert(_cancellation: vscode.CancellationToken): Promise<void> {
        const diskContent = await ExcelDocument.readFile(this.uri);
        this._documentData = diskContent;
        this._ready = Promise.resolve();
        this._dirty = false;
        this._onDidChangeDocument.fire({
            content: diskContent
        });
    }

    async backup(
        destination: vscode.Uri,
        cancellation: vscode.CancellationToken
    ): Promise<vscode.CustomDocumentBackup> {
        await this.saveAs(destination, cancellation);

        return {
            id: destination.toString(),
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(destination);
                } catch {
                    // noop
                }
            }
        };
    }

    dispose(): void {
        this._onDidDispose.fire();
        super.dispose();
    }
}

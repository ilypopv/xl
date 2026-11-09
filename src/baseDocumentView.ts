'use strict';
import { window, ExtensionContext, Disposable, ViewColumn, Webview, WebviewPanel, Memento } from 'vscode';
import { URI, Utils } from 'vscode-uri';
import { openExternalLink } from './links';
import { documentViewManager } from './documentViewManager';

const MAX_STATE_CHARS = 1024 * 1024;
// Minified bundles produced by scripts/build-webview.js
const WEBVIEW_DIR = 'dist/webview';

function isSaneState(state: any): boolean {
    if (state === null) {
        return true;
    }
    if (typeof state !== 'object') {
        return false;
    }
    try {
        return JSON.stringify(state).length <= MAX_STATE_CHARS;
    } catch (err) {
        return false;
    }
}

export default abstract class BaseDocumentView {
    private _uri: URI;
    private _previewUri: URI;
    private _scriptUri: URI;
    private _extensionUri: URI;
    private _storage: Memento;
    private _panel: WebviewPanel;
    private _customEditor: boolean = true;
    protected _disposed: boolean = false;
    protected _disposables: Disposable[] = [];

    constructor(context: ExtensionContext, uri: URI) {
        this._uri = uri;
        this._extensionUri = context.extensionUri;
        this._scriptUri = Utils.joinPath(context.extensionUri, WEBVIEW_DIR);
        this._storage = context.workspaceState;
        documentViewManager.add(this);
    }

    protected initWebviewPanel(viewColumn: ViewColumn): BaseDocumentView {
        let title = `Preview '${Utils.basename(this._uri)}'`;
        let panel = window.createWebviewPanel(this.viewType, title, viewColumn, {
            enableScripts: true,
            enableFindWidget: false,
            retainContextWhenHidden: true,
            localResourceRoots: [Utils.joinPath(this._extensionUri, WEBVIEW_DIR)]
        });
        return this.attachWebviewPanel(panel);
    }

    protected attachWebviewPanel(webviewPanel: WebviewPanel): BaseDocumentView {
        this._customEditor = false;
        this.bindPanel(webviewPanel);
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [Utils.joinPath(this._extensionUri, WEBVIEW_DIR)]
        };
        return this;
    }

    protected allowLocalRoots(extra: URI[]) {
        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [Utils.joinPath(this._extensionUri, WEBVIEW_DIR), ...extra]
        };
    }

    public initialize() {
        this.webview.onDidReceiveMessage(
            e => {
                if (!e || typeof e !== 'object') {
                    return;
                }
                if (e.save) {
                    if (isSaneState(e.state)) {
                        this.state = e.state;
                    }
                } else if (e.refresh) {
                    this.refresh();
                } else if (e.error) {
                    window.showErrorMessage(String(e.error));
                } else if (typeof e.openLink === 'string') {
                    openExternalLink(e.openLink);
                }
            },
            this,
            this._disposables
        );

        this.webview.html = this.getHtml();
    }

    public dispose() {
        if (this._disposed) {
            return;
        }
        documentViewManager.remove(this);
        this._disposed = true;
        while (this._disposables.length) {
            const item = this._disposables.pop();
            if (item) {
                item.dispose();
            }
        }
    }

    public configure() {
        if (this.configurable) {
            this.webview.html = this.getHtml();
            this.refresh();
        }
    }

    public reload() {
        this.webview.html = this.getHtml(true);
    }

    public reveal() {
        this._panel.reveal();
    }

    get hasCustomEditor(): boolean {
        return this._customEditor;
    }

    get visible(): boolean {
        return this._panel.visible;
    }

    get webview(): Webview {
        return this._panel.webview;
    }

    get panel(): WebviewPanel {
        return this._panel;
    }

    set panel(value: WebviewPanel) {
        this.bindPanel(value);
        value.webview.options = {
            enableScripts: true,
            localResourceRoots: [Utils.joinPath(this._extensionUri, WEBVIEW_DIR)]
        };
    }

    private bindPanel(panel: WebviewPanel) {
        this._panel = panel;
        this._previewUri = panel.webview.asWebviewUri(this._uri);
        this._scriptUri = panel.webview.asWebviewUri(Utils.joinPath(this._extensionUri, WEBVIEW_DIR));
        panel.onDidDispose(
            () => {
                this.dispose();
            },
            this,
            this._disposables
        );
    }

    get isDisposed(): boolean {
        return this._disposed;
    }

    set scheme(value: string) {
        this._previewUri = this._uri.with({
            scheme: value
        });
    }

    get uri(): URI {
        return this._uri;
    }

    get previewUri(): URI {
        return this._previewUri;
    }

    get scriptUri(): URI {
        return this._scriptUri;
    }

    private get stateKey(): string {
        return (this._customEditor ? 'editor:' : 'preview:') + this.viewType + ':' + this._uri.toString();
    }

    get state(): any {
        return this._storage.get(this.stateKey, null);
    }
    set state(value: any) {
        this._storage.update(this.stateKey, value);
    }

    // Command entry points. Editors with unsaved work override canDiscardView to refuse.
    public get focused(): boolean {
        return this._panel.active;
    }

    public get hasUnsavedEdits(): boolean {
        return false;
    }

    public userRefresh() {
        if (this.hasUnsavedEdits) {
            window.showWarningMessage(
                'This editor has unsaved edits; save or revert first, a refresh would discard them.'
            );
            return;
        }
        this.refresh();
    }

    public clearState() {
        if (this.hasUnsavedEdits) {
            window.showWarningMessage(
                'This editor has unsaved edits; save or revert first, then clear the preview state.'
            );
            return;
        }
        this.state = null;
        this.reload();
        this.refresh();
    }

    abstract get viewType(): string;
    abstract getHtml(ignoreState?: boolean): string;
    abstract refresh(): void;
    abstract get configurable(): boolean;
}

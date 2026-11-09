'use strict';
import {
    window,
    workspace,
    WebviewPanel,
    ExtensionContext,
    ViewColumn,
    WorkspaceEdit,
    TextDocument,
    EndOfLine,
    Range
} from 'vscode';
import { URI } from 'vscode-uri';
import BaseDocumentView from './baseDocumentView';
import { LineEdit, buildTextOps } from './csvLineEdits';
import { safeJson, makeNonce, csp, cleanString, cleanEnum } from './html';

const MAX_EDITS = 200000;
const MAX_EDIT_CHARS = 32 * 1024 * 1024;

function languageFromPath(path: string): string | undefined {
    const m = /\.([^./\\]+)$/.exec(path);
    const ext = m ? m[1].toLowerCase() : '';
    return ext === 'tsv' || ext === 'tab' ? 'tsv' : ext === 'csv' ? 'csv' : undefined;
}

const INLINE_CHARS = 4 * 1024 * 1024;
const CHUNK_CHARS = 1024 * 1024;

export default class CsvDocumentView extends BaseDocumentView {
    static create(context: ExtensionContext, uri: URI, viewColumn: ViewColumn): CsvDocumentView {
        let preview = new CsvDocumentView(context, uri);
        preview.scheme = 'csv-preview';
        preview.initWebviewPanel(viewColumn);
        preview.initialize();
        return preview;
    }

    static revive(context: ExtensionContext, uri: URI, webviewPanel: WebviewPanel): CsvDocumentView {
        let preview = new CsvDocumentView(context, uri);
        preview.scheme = 'csv-preview';
        preview.attachWebviewPanel(webviewPanel);
        preview.initialize();
        return preview;
    }

    public languageId: string;
    private separator: string;
    private _document: TextDocument;
    private _queue: Promise<void> = Promise.resolve();
    private _inflight = false;
    private _seenVersions: number[] = [];
    private _refreshTimer: any;
    private _sendId = 0;
    // Document version the webview is known to be in sync with (-1: unknown, edits are stale).
    private _viewVersion = -1;

    public getOptions(): any {
        let config = workspace.getConfiguration('csv-preview');
        let sep = cleanString(config.get('separator'), ',', 8);
        let lang = this.languageId;
        if (!lang) {
            let document = workspace.textDocuments.find(d => d.uri.toString() === this.uri.toString());
            lang = document ? document.languageId : languageFromPath(this.uri.path);
            if (lang) {
                this.languageId = lang;
            }
        }
        if (lang === 'tsv') {
            sep = '\t';
        } else if (lang === 'csv (semicolon)') {
            sep = ';';
        } else if (lang === 'csv (pipe)') {
            sep = '|';
        }
        if (this.separator) {
            sep = this.separator;
        }
        return {
            separator: sep,
            languageId: typeof lang === 'string' ? lang.slice(0, 64) : lang,
            quoteMark: cleanString(config.get('quoteMark'), '"', 1),
            hasHeaders: config.get('hasHeaders') === true,
            capitalizeHeaders: config.get('capitalizeHeaders') === true,
            resizeColumns: cleanEnum(config.get('resizeColumns'), ['all', 'first', 'none'], 'none'),
            lineNumbers: cleanEnum(config.get('lineNumbers'), ['none', 'ordinal', 'source'], 'none'),
            commentCharacter: cleanString(config.get('commentCharacter'), '#', 4),
            skipComments: config.get('skipComments') === true,
            formatValues: cleanEnum(config.get('formatValues'), ['always', 'never', 'unquoted'], 'always'),
            numberFormat: cleanString(config.get('numberFormat'), '', 64, 0),
            customEditor: this.hasCustomEditor,
            uri: this.uri.toString(),
            previewUri: this.previewUri.toString(),
            state: this.state
        };
    }

    public initialize() {
        super.initialize();
        workspace.onDidChangeTextDocument(
            e => {
                if (this._disposed || e.document.uri.toString() !== this.uri.toString()) {
                    return;
                }
                if (this._inflight) {
                    this._seenVersions.push(e.document.version);
                    return;
                }
                if (e.contentChanges.length === 0) {
                    return;
                }
                this._viewVersion = -1;
                this.scheduleRefresh();
            },
            this,
            this._disposables
        );
    }

    public enableEditing(document: TextDocument) {
        this._document = document;
        this.webview.onDidReceiveMessage(
            e => {
                if (!e || typeof e !== 'object') {
                    return;
                }
                if (e.lineEdits !== undefined) {
                    const edits = e.lineEdits,
                        version = e.version;
                    this.enqueue(() => this.applyLineEdits(edits, version));
                } else if (typeof e.separator === 'string' && e.separator.length >= 1 && e.separator.length <= 8) {
                    this.separator = e.separator;
                }
            },
            this,
            this._disposables
        );
    }

    // All host-side document work is serialized so line numbers always refer to the state the webview assumes.
    private enqueue(task: () => Promise<void>) {
        this._queue = this._queue.then(task).catch(() => this.scheduleRefresh());
    }

    // Returns the sanitized edits, or undefined when the message is malformed or out of the document's range.
    private validateEdits(edits: any, lineCount: number): LineEdit[] | undefined {
        if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) {
            return undefined;
        }
        const out: LineEdit[] = [];
        let chars = 0;
        for (const e of edits) {
            if (
                !e ||
                typeof e.text !== 'string' ||
                !Number.isInteger(e.start) ||
                !Number.isInteger(e.end) ||
                e.start < 0 ||
                e.end < e.start ||
                e.start > lineCount ||
                e.end > lineCount
            ) {
                return undefined;
            }
            chars += e.text.length;
            if (chars > MAX_EDIT_CHARS) {
                return undefined;
            }
            out.push({ start: e.start, end: e.end, text: e.text });
        }
        return out;
    }

    private async applyLineEdits(rawEdits: any, version: any) {
        const doc = this._document;
        if (version !== this._viewVersion || doc.version !== this._viewVersion) {
            // computed against content the document no longer has: never apply, resync instead
            this._viewVersion = -1;
            this.scheduleRefresh();
            return;
        }
        const edits = this.validateEdits(rawEdits, doc.lineCount);
        if (!edits) {
            this._viewVersion = -1;
            this.scheduleRefresh();
            return;
        }
        const eol = doc.eol === EndOfLine.CRLF ? '\r\n' : '\n';
        const ops = buildTextOps({ lineCount: doc.lineCount, lineLength: i => doc.lineAt(i).text.length }, eol, edits);
        if (!ops.length) {
            this._viewVersion = -1;
            this.scheduleRefresh();
            return;
        }
        const wsEdit = new WorkspaceEdit();
        for (const o of ops) {
            wsEdit.replace(this.uri, new Range(o.sl, o.sc, o.el, o.ec), o.text);
        }
        const before = doc.version;
        this._seenVersions = [];
        this._inflight = true;
        let ok = false;
        try {
            ok = await workspace.applyEdit(wsEdit);
        } finally {
            this._inflight = false;
        }
        // Anything other than our own single version bump means an external/undo change landed: resync.
        const seen = this._seenVersions;
        this._seenVersions = [];
        if (!ok || doc.version !== before + 1 || seen.some(v => v !== before + 1)) {
            this._viewVersion = -1;
            this.scheduleRefresh();
        } else {
            this._viewVersion = doc.version;
        }
    }

    private scheduleRefresh() {
        if (this._refreshTimer || this._disposed) {
            return;
        }
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = undefined;
            this.refresh();
        }, 20);
    }

    public dispose() {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = undefined;
        }
        this._sendId++;
        super.dispose();
    }

    refresh(): void {
        const id = ++this._sendId; // a newer refresh cancels a transfer in flight
        this.enqueue(async () => {
            if (this._disposed || id !== this._sendId) {
                return;
            }
            try {
                const document = await workspace.openTextDocument(this.uri);
                if (this._disposed || id !== this._sendId) {
                    return;
                }
                const last = document.lineCount - 1;
                const total = document.offsetAt(document.lineAt(last).range.end);
                if (total <= INLINE_CHARS) {
                    this._viewVersion = document.version;
                    this.webview.postMessage({
                        refresh: true,
                        content: document.getText(),
                        version: document.version
                    });
                } else {
                    await this.sendChunks(document, id, total);
                }
            } catch (reason) {
                window.showInformationMessage((reason && (reason as Error).message) || String(reason));
            }
        });
    }

    // Big documents go out as ordered line-aligned chunks so no single message or string holds the whole file.
    private async sendChunks(document: TextDocument, id: number, total: number) {
        const version = document.version;
        const lines = document.lineCount;
        const eol = document.eol === EndOfLine.CRLF ? '\r\n' : '\n';
        const alive = () => !this._disposed && id === this._sendId;
        const post = async (m: any) => (await this.webview.postMessage(Object.assign({ id, version }, m))) !== false;
        this._viewVersion = version;
        if (!(await post({ refreshChunk: 'start', chars: total, lines }))) {
            return;
        }
        let seq = 0,
            l0 = 0,
            perChunk = Math.max(1, Math.min(1000, Math.floor((CHUNK_CHARS * lines) / Math.max(1, total))));
        while (l0 < lines) {
            if (!alive()) {
                return;
            }
            if (document.version !== version) {
                this.scheduleRefresh();
                return;
            }
            const l1 = Math.min(lines, l0 + perChunk);
            const lastChunk = l1 >= lines;
            const text = document.getText(
                lastChunk
                    ? new Range(l0, 0, lines - 1, document.lineAt(lines - 1).text.length)
                    : new Range(l0, 0, l1, 0)
            );
            if (l1 - l0 === 1 && text.length > 2 * CHUNK_CHARS) {
                // one enormous line: split it by characters, never inside a surrogate pair
                const body = text.endsWith(eol) ? text.slice(0, text.length - eol.length) : text;
                const tail = body.length === text.length ? '' : eol;
                for (let a = 0; a < body.length;) {
                    let b = Math.min(body.length, a + CHUNK_CHARS);
                    const c = body.charCodeAt(b - 1);
                    if (b < body.length && c >= 0xd800 && c <= 0xdbff) {
                        b++;
                    }
                    if (
                        !alive() ||
                        !(await post({
                            refreshChunk: 'data',
                            seq: seq++,
                            text: body.slice(a, b) + (b >= body.length ? tail : '')
                        }))
                    ) {
                        return;
                    }
                    a = b;
                }
            } else {
                if (!(await post({ refreshChunk: 'data', seq: seq++, text }))) {
                    return;
                }
                perChunk = Math.max(
                    1,
                    Math.min(1000000, Math.floor((perChunk * CHUNK_CHARS) / Math.max(1, text.length)))
                );
            }
            l0 = l1;
        }
        if (alive()) {
            await post({ refreshChunk: 'end', count: seq });
        }
    }

    getHtml(ignoreState: boolean = false): string {
        const s = this.scriptUri;
        const nonce = makeNonce();
        return `
        <!DOCTYPE html>
        <html>
        <head>
        <meta http-equiv="Content-Security-Policy" content="${csp(this.webview.cspSource, nonce)}">
            <link href="${s}/style.css" rel="stylesheet" type="text/css" />
        </head>
        <body>
            <div id="app"></div>
            <script nonce="${nonce}" src="${s}/csv.js"></script>
            <script nonce="${nonce}" type="text/javascript">
                function ignoreState() {
                    return ${ignoreState === true};
                }
                function getOptions() {
                    return ${safeJson(this.getOptions())};
                }
                handleEvents();
                initPage();
            </script>
        </body>
        </html>`;
    }

    get viewType(): string {
        return 'xl-csv-preview';
    }

    get configurable(): boolean {
        return true;
    }
}

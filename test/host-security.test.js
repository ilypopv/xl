'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sim = require('./helpers/csv-host-sim.js');
const { run, edit, drain, tick } = require('./helpers/csv-host-ops.js');

const evil = '</script><script>alert(1)</script>  &';

test('getHtml: inline JSON is inert, every script has the nonce, CSP has no script unsafe-inline', async () => {
    const w = sim.makeWebview('a,b\n1,2\n', 1, { separator: evil, commentCharacter: evil, numberFormat: evil });
    const html = w.view.getHtml();
    const nonce = /script-src [^;]*'nonce-([A-Za-z0-9]+)'/.exec(html)[1];
    assert.ok(nonce.length >= 32);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(html));
    const tags = html.match(/<script\b[^>]*>/g);
    assert.ok(tags.length >= 2);
    for (const t of tags) assert.ok(t.includes('nonce="' + nonce + '"'), t);
    assert.strictEqual((html.match(/<\/script>/g) || []).length, tags.length);
    assert.ok(!new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']').test(html));
    // out-of-range config values fall back to defaults
    const o = w.view.getOptions();
    assert.strictEqual(o.separator, ',');
    assert.strictEqual(o.commentCharacter, '#');
    assert.strictEqual(o.numberFormat, evil); // short enough to be kept; escaped in the page
});

test('language comes from the previewed document, not the active editor', () => {
    const w = sim.makeWebview('a\tb\n', 1);
    w.view.languageId = undefined;
    sim.vscode.window.activeTextEditor = { document: { languageId: 'csv' } };
    sim.vscode.workspace.textDocuments = [{ uri: w.view.uri, languageId: 'tsv' }];
    assert.strictEqual(w.view.getOptions().separator, '\t');
    sim.vscode.window.activeTextEditor = null;
    sim.vscode.workspace.textDocuments = [];
    w.view.languageId = undefined;
    Object.defineProperty(w.view, '_uri', {
        value: require('vscode-uri').URI.parse('file:///x/b.tsv'),
        writable: true
    });
    assert.strictEqual(w.view.getOptions().languageId, 'tsv');
});

test('stale line edits (external change before the refresh lands) are dropped and resynced', async () => {
    const w = sim.makeWebview('a,1\nb,2\nc,3\n', 1, { hasHeaders: false });
    await drain(w);
    sim.externalEdit('HEADER\na,1\nb,2\nc,3\n');
    w.shell().o.onEdit([{ r: 1, c: 1, text: '99' }], 'type');
    await drain(w);
    await new Promise(r => setTimeout(r, 60));
    await drain(w);
    assert.strictEqual(w.doc.text, 'HEADER\na,1\nb,2\nc,3\n');
    const p = w.shell().provider;
    assert.strictEqual(p.getRaw(0, 0), 'HEADER');
});

test('consecutive edits before the host replies all apply', async () => {
    const w = sim.makeWebview('a,b\n1,2\n3,4\n', 1);
    await drain(w);
    const o = w.shell().o;
    o.onEdit([{ r: 1, c: 0, text: 'X' }], 'type');
    o.onEdit([{ r: 2, c: 1, text: 'Y' }], 'type');
    await drain(w);
    assert.strictEqual(w.doc.text, 'a,b\nX,2\n3,Y\n');
});

test('malformed lineEdits never touch the document', async () => {
    const w = sim.makeWebview('a,b\n1,2\n', 1);
    await drain(w);
    const before = w.doc.text;
    const v = w.doc.version;
    const bad = [
        [],
        'x',
        [{ start: -1, end: 0, text: 'h' }],
        [{ start: 0, end: 99, text: 'h' }],
        [{ start: 1.5, end: 2, text: 'h' }],
        [{ start: 0, end: 1, text: 5 }],
        [{ start: 2, end: 1, text: 'h' }],
        [null]
    ];
    for (const b of bad) {
        w.view.enqueue(() => w.view.applyLineEdits(b, w.view._viewVersion));
        await drain(w);
        assert.strictEqual(w.doc.text, before);
        assert.strictEqual(w.doc.version, v);
        await new Promise(r => setTimeout(r, 40));
        await drain(w);
    }
});

test('empty and blank-line-only files accept a header edit', async () => {
    for (const [name, text] of [
        ['empty', ''],
        ['nl', '\n'],
        ['crlf', '\r\n']
    ]) {
        const r = await run(name, text, 1, [edit(0, 0, 'h')]);
        assert.ok(/(^|\n)h/.test(r.w.doc.text), name + ' ' + JSON.stringify(r.w.doc.text));
    }
});

test('toWorkbookBytes accepts only non-empty zips', () => {
    require('node:module');
    const { URI } = require('vscode-uri');
    const ts = require('typescript');
    const fs = require('fs');
    const m = { exports: {} };
    const src = fs.readFileSync(__dirname + '/../src/excelDocumentView.ts', 'utf8');
    const fn = /export function toWorkbookBytes[\s\S]*?\n}\n/.exec(src)[0].replace('export ', '');
    const js = ts.transpileModule(
        'const MAX_FILE_BYTES = 1024*1024*1024;\n' + fn + '\nmodule.exports = toWorkbookBytes;',
        { compilerOptions: { target: 'es2019', module: 'commonjs' } }
    ).outputText;
    new Function('module', js)(m);
    const f = m.exports;
    assert.ok(f(new Uint8Array([0x50, 0x4b, 3, 4, 0])));
    assert.ok(f(new Uint8Array([0x50, 0x4b, 3, 4, 0]).buffer));
    assert.ok(f({ length: 5, 0: 0x50, 1: 0x4b, 2: 3, 3: 4, 4: 0 }));
    assert.strictEqual(f(new Uint8Array(0)), undefined);
    assert.strictEqual(f('hello'), undefined);
    assert.strictEqual(f({ length: 2e9 }), undefined);
    assert.strictEqual(f(new Uint8Array([1, 2, 3, 4])), undefined);
    assert.strictEqual(f(null), undefined);
});

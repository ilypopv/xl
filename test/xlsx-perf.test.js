'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.fflate = require('../out/vendor/fflate.js');
globalThis.SSF = require('../out/vendor/ssf.js');
const OX = require('../out/core/xlsx-reader.js');
require('../out/core/format.js');
require('../out/core/xlsx-provider.js');
const F = require('./helpers/xlsx-fixtures.js');

const sstOf = arr => ({
    length: arr.length,
    has: i => i >= 0 && i < arr.length,
    get: i => (i >= 0 && i < arr.length ? arr[i] : '')
});
const ctx = () => ({ sst: sstOf(['alpha', 'beta & gamma', '', 'a long shared string value']), resolve: () => null });

function snapshot(sh) {
    const rows = [];
    sh.rows.forEach((r, i) => {
        if (r) {
            const o = [];
            r.forEach((c, j) => {
                o[j] = c;
            });
            rows[i] = o;
        }
    });
    const { store, rows: _r, info, partial, ...rest } = sh;
    return JSON.stringify({ rows, rest }, (k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
}
function parseChunks(xml, sizes) {
    const p = OX.createSheetParser({ index: 0, name: 'S', tabColor: null, path: 'x' }, ctx(), null);
    let i = 0,
        k = 0;
    while (i < xml.length) {
        const n = sizes(k++);
        p.feed(xml.substring(i, i + n), false);
        i += n;
    }
    p.feed('', true);
    return p.sheet;
}
function oneShot(xml) {
    const p = OX.createSheetParser({ index: 0, name: 'S', tabColor: null, path: 'x' }, ctx(), null);
    p.feed(xml, true);
    return p.sheet;
}
function rng(seed) {
    let h = seed;
    return () => (h = (h * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function mixedXml(rows, prefix, shuffle) {
    const x = prefix ? prefix + ':' : '';
    const rs = [];
    for (let r = 0; r < rows; r++) {
        let c = `<${x}row r="${r + 1}"${r % 7 === 0 ? ' ht="30" customHeight="1"' : ''}${r % 11 === 3 ? ' hidden="1"' : ''}>`;
        c += `<${x}c r="A${r + 1}" t="s"><${x}v>${r % 4}</${x}v></${x}c>`;
        c += `<${x}c r="B${r + 1}" s="2"><${x}v>${r * 1.25}</${x}v></${x}c>`;
        c += `<${x}c r="C${r + 1}"><${x}f t="shared" ref="C1:C${rows}" si="0">B1*2+$A$1</${x}f><${x}v>1</${x}v></${x}c>`
            .replace('B1*2+$A$1', r === 0 ? 'B1*2+$A$1' : '')
            .replace(/(<\w*:?f t="shared" ref="C1:C\d+" si="0">)(<\/)/, '$1$2');
        c += `<${x}c r="D${r + 1}" t="inlineStr"><${x}is><${x}t>inline &amp; text number ${r} with some length</${x}t></${x}is></${x}c>`;
        c += `<${x}c r="E${r + 1}" t="b"><${x}v>${r & 1}</${x}v></${x}c><${x}c r="F${r + 1}" s="3"/><${x}c r="G${r + 1}" t="str"><${x}f>"x"&amp;A${r + 1}</${x}f><${x}v>x&lt;${r}</${x}v></${x}c>`;
        rs.push(c + `</${x}row>`);
    }
    if (shuffle) {
        const g = rng(5);
        for (let i = rs.length - 1; i > 0; i--) {
            const j = Math.floor(g() * (i + 1));
            [rs[i], rs[j]] = [rs[j], rs[i]];
        }
    }
    return (
        F.HDR +
        `<${x}worksheet xmlns${prefix ? ':' + prefix : ''}="${F.NS}"><${x}dimension ref="A1:G${rows}"/><${x}sheetViews><${x}sheetView><${x}pane ySplit="1" state="frozen"/></${x}sheetView></${x}sheetViews><${x}sheetData>${rs.join('')}</${x}sheetData><${x}mergeCells count="1"><${x}mergeCell ref="A1:B2"/></${x}mergeCells></${x}worksheet>`
    );
}

test('streaming parser: random chunk boundaries equal the one-shot result', () => {
    for (const [prefix, shuffle] of [
        [null, false],
        ['x', false],
        [null, true]
    ]) {
        const xml = mixedXml(120, prefix, shuffle);
        const want = snapshot(oneShot(xml));
        assert.ok(want.length > 5000);
        const g = rng(42);
        for (let t = 0; t < 40; t++) {
            const max = [1, 2, 3, 7, 13, 50, 300, 4000][t % 8];
            const got = snapshot(parseChunks(xml, () => 1 + Math.floor(g() * max)));
            assert.equal(got, want, `prefix=${prefix} shuffle=${shuffle} max=${max}`);
        }
        assert.equal(snapshot(parseChunks(xml, () => 1)), want);
    }
});

test('shared formulas expand lazily and survive chunking', () => {
    const xml = F.sheetXml({
        data: '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1+1</f><v>2</v></c></row><row r="2"><c r="B2"><f t="shared" si="0"/><v>3</v></c></row><row r="3"><c r="B3"><f t="shared" si="0"/><v>4</v></c></row>'
    });
    for (const sh of [oneShot(xml), parseChunks(xml, () => 5)]) {
        assert.equal(sh.rows[1][1].f, 'A2+1');
        assert.equal(sh.rows[2][1].f, 'A3+1');
        assert.equal(sh.store.get(2, 1).f, 'A3+1');
        assert.equal(sh.store.get(0, 0).f, undefined);
    }
});

test('out-of-order rows and duplicate cells end up sorted, last wins', () => {
    const xml = F.sheetXml({
        data: '<row r="3"><c r="B3"><v>3</v></c></row><row r="1"><c r="C1"><v>1</v></c><c r="A1"><v>7</v></c></row><row r="1"><c r="A1"><v>8</v></c></row>'
    });
    const sh = oneShot(xml);
    assert.equal(sh.store.get(0, 0).v, 8);
    assert.equal(sh.store.get(0, 2).v, 1);
    assert.equal(sh.store.get(2, 1).v, 3);
    assert.equal(sh.store.get(1, 0), undefined);
    assert.equal(sh.rowCount, 3);
    assert.equal(sh.colCount, 3);
});

function bigBook(rows) {
    let d = '';
    for (let r = 1; r <= rows; r++)
        d += `<row r="${r}"><c r="A${r}" t="s"><v>${r % 50}</v></c><c r="B${r}"><v>${r}</v></c><c r="C${r}"><f>B${r}*2</f><v>${r * 2}</v></c></row>`;
    const strings = [];
    for (let i = 0; i < 50; i++) strings.push('item ' + i);
    return F.buildPackage({
        sheets: [{ name: 'Big', xml: F.sheetXml({ dim: `<dimension ref="A1:C${rows}"/>`, data: d }) }],
        sst: F.sst(strings),
        styles: F.STYLES,
        theme: F.THEME
    });
}

test('large sheet: sync, async, progressive and cancel', async () => {
    const bytes = bigBook(60000);
    const sync = OX.readXlsx(bytes).loadSheet(0);
    assert.equal(sync.rowCount, 60000);
    assert.equal(sync.partial, false);
    assert.equal(sync.store.get(59999, 2).f, 'B60000*2');
    assert.equal(sync.store.get(10, 0).v, 'item 11');
    const wb = OX.readXlsx(bytes);
    const seen = [];
    const sh = await wb.loadSheetAsync(0, {
        onProgress: i => seen.push([i.partial, i.rows, i.fraction, i.sheet.partial])
    });
    assert.equal(sh.partial, false);
    assert.equal(sh.rowCount, 60000);
    assert.equal(seen[seen.length - 1][0], false);
    assert.ok(
        seen.some(s => s[0] === true && s[1] > 0 && s[1] < 60000 && s[3] === true),
        'a partial frame with some rows is reported'
    );
    for (let r = 0; r < 60000; r += 997) assert.deepEqual(sh.store.get(r, 1), sync.store.get(r, 1));
    assert.equal(await wb.loadSheetAsync(0), sh);
    // provider on a partial sheet shows dimension extent and live rows
    const wb2 = OX.readXlsx(bytes);
    let prov = null;
    await wb2.loadSheetAsync(0, {
        onProgress: i => {
            if (i.partial && !prov) {
                prov = new OX.XlsxProvider(wb2, i.sheet);
                assert.equal(prov.rowCount, 60000);
                assert.ok(prov.partial);
            }
        }
    });
    assert.ok(prov && !prov.partial);
    assert.equal(prov.getCell(5, 1).text, '6');
    // cancel
    const wb3 = OX.readXlsx(bytes),
        ac = new AbortController();
    const p = wb3.loadSheetAsync(0, { signal: ac.signal, onProgress: () => ac.abort() });
    await assert.rejects(p, { name: 'AbortError' });
    const again = await wb3.loadSheetAsync(0);
    assert.equal(again.rowCount, 60000);
    await assert.rejects(wb3.loadSheetAsync(9), /No such sheet/);
});

test('corrupt sheet part rejects instead of hanging', async () => {
    const bytes = bigBook(5000);
    const cut = bytes.slice(0, Math.floor(bytes.length * 0.5));
    let wb;
    try {
        wb = OX.readXlsx(cut);
    } catch (e) {
        return;
    }
    await assert.rejects(Promise.resolve().then(() => wb.loadSheetAsync(0)));
    assert.throws(() => OX.readXlsx(cut).loadSheet(0));
});

test('memory: compact store stays far below object-per-cell cost', () => {
    const wb = OX.readXlsx(bigBook(100000));
    global.gc && global.gc();
    const h0 = process.memoryUsage();
    const sh = wb.loadSheet(0);
    global.gc && global.gc();
    const h1 = process.memoryUsage();
    const per = (h1.heapUsed - h0.heapUsed + (h1.arrayBuffers - h0.arrayBuffers)) / sh.store.n;
    assert.equal(sh.store.n, 300000);
    if (global.gc) assert.ok(per < 40, 'bytes per cell ' + per);
});

test('lazy sharedStrings index equals the eager one across tiny inflate chunks', () => {
    const items = [];
    for (let i = 0; i < 400; i++) {
        if (i % 17 === 0)
            items.push({ raw: '' }); // <si></si> style empty entry
        else if (i % 13 === 0)
            items.push({ raw: '<r><t>rich </t></r><r><t xml:space="preserve">text ' + i + '</t></r>' });
        else if (i % 11 === 0) items.push({ raw: '<t>ph</t><rPh sb="0" eb="1"><t>x</t></rPh>' });
        else items.push('Zażółć gęślą jaźń 日本語 😀 ' + i + ' & <b> ' + 'x'.repeat(i % 50));
    }
    const rows = [];
    for (let r = 0; r < 420; r++) rows.push(`<row r="${r + 1}"><c r="A${r + 1}" t="s"><v>${r}</v></c></row>`);
    const buf = F.buildPackage({
        sheets: [{ name: 'S', xml: F.sheetXml({ data: rows.join('') }) }],
        sst: F.sst(items),
        level: 6
    });
    const eager = OX.readXlsx(buf, { limits: { lazySst: Infinity } }).loadSheet(0);
    for (const chunk of [1, 3, 64, 500]) {
        const wb = OX.readXlsx(buf, { limits: { lazySst: 0, sstChunk: chunk } });
        assert.equal(snapshot(wb.loadSheet(0)), snapshot(eager), 'chunk ' + chunk);
    }
});

test('lazy sharedStrings enforce the inflate cap while streaming', () => {
    const items = [];
    for (let i = 0; i < 5000; i++) items.push('s' + i + 'x'.repeat(200));
    const buf = F.buildPackage({
        sheets: [{ name: 'S', xml: F.sheetXml({ data: '<row r="1"><c r="A1" t="s"><v>4999</v></c></row>' }) }],
        sst: F.sst(items),
        level: 6
    });
    const wb = OX.readXlsx(buf, { limits: { lazySst: 0, sstChunk: 256, ratio: 2, ratioMin: 1000 } });
    assert.throws(
        () => wb.loadSheet(0),
        e => e.code === 'ZIPBOMB'
    );
});

test('native inflate path: same sheet as the fflate path', async () => {
    const bytes = bigBook(8000);
    const ref = OX.readXlsx(bytes, { limits: { nativeInflate: Infinity } }).loadSheet(0);
    const seen = [];
    const sh = await OX.readXlsx(bytes, { limits: { nativeInflate: 0 } }).loadSheetAsync(0, {
        onProgress: i => seen.push(i.fraction)
    });
    assert.equal(snapshot(sh), snapshot(ref));
    assert.equal(sh.partial, false);
    assert.equal(seen[seen.length - 1], 1);
    assert.ok(seen.every(f => f >= 0 && f <= 1));
});

test('native inflate path: bomb rule, corrupt data and cancel', async () => {
    const bytes = bigBook(8000);
    await assert.rejects(
        OX.readXlsx(bytes, { limits: { nativeInflate: 0, ratio: 2, ratioMin: 200000 } }).loadSheetAsync(0),
        e => e.code === 'ZIPBOMB'
    );
    const bad = bytes.slice();
    bad.fill(0xff, Math.floor(bad.length * 0.4), Math.floor(bad.length * 0.6));
    const wb = OX.readXlsx(bad, { limits: { nativeInflate: 0 } });
    await assert.rejects(wb.loadSheetAsync(0));
    const ac = new AbortController();
    const wb2 = OX.readXlsx(bigBook(60000), { limits: { nativeInflate: 0 } });
    await assert.rejects(wb2.loadSheetAsync(0, { signal: ac.signal, onProgress: () => ac.abort() }), {
        name: 'AbortError'
    });
    assert.equal((await wb2.loadSheetAsync(0)).rowCount, 60000);
});

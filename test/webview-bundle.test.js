'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { build } = require('../scripts/build-webview.js');

test('minified webview bundles evaluate and expose the page API', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-bundle-'));
    try {
        const sizes = await build(dir);
        assert.ok(sizes['excel.js'] > 1000 && sizes['csv.js'] > 1000 && sizes['style.css'] > 100);

        const excel = vm.createContext({ console });
        vm.runInContext(fs.readFileSync(path.join(dir, 'excel.js'), 'utf8'), excel);
        const ex = vm.runInContext(
            `({ init: typeof initPage, ev: typeof handleEvents, ssf: typeof SSF, fl: typeof fflate,
                api: ['readXlsx','XlsxProvider','Shell'].filter(k => typeof OX[k] !== 'function') })`,
            excel
        );
        assert.deepEqual(JSON.parse(JSON.stringify(ex)), {
            init: 'function',
            ev: 'function',
            ssf: 'object',
            fl: 'object',
            api: []
        });

        // editing pieces stay out of the first-paint bundle and attach to the same OX when fetched
        assert.equal(vm.runInContext('typeof OX.patchXlsx + typeof OX.Calc', excel), 'undefinedundefined');
        vm.runInContext(fs.readFileSync(path.join(dir, 'excel-edit.js'), 'utf8'), excel);
        assert.equal(vm.runInContext('typeof OX.patchXlsx + typeof OX.Calc', excel), 'functionfunction');

        const csv = vm.createContext({ console });
        vm.runInContext(fs.readFileSync(path.join(dir, 'csv.js'), 'utf8'), csv);
        assert.equal(vm.runInContext('typeof initPage + typeof OX.Shell', csv), 'functionfunction');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

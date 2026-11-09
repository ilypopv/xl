'use strict';
// Bundles and minifies the webview scripts/styles from out/ into dist/webview (one request per page).
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'out');

const BUNDLES = {
    excel: [
        'vendor/fflate.js',
        'vendor/ssf.js',
        'core/format.js',
        'core/xlsx-reader.js',
        'core/xlsx-provider.js',
        'core/grid-core.js',
        'core/grid.js',
        'core/app-shell.js',
        'excel.js'
    ],
    // loaded on demand by excel.js: only editing and saving need the formula engine and the writer
    'excel-edit': ['core/xlsx-writer.js', 'core/calc.js'],
    csv: [
        'core/format.js',
        'core/csv-parser.js',
        'core/csv-provider.js',
        'core/grid-core.js',
        'core/grid.js',
        'core/app-shell.js',
        'csv.js'
    ]
};
const STYLES = ['core/grid.css', 'styles/vscode.css'];

function minifyCss(css) {
    return css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([{};:,>])\s*/g, '$1')
        .replace(/;}/g, '}')
        .trim();
}

async function build(outDir) {
    outDir = outDir || path.join(ROOT, 'dist', 'webview');
    fs.mkdirSync(outDir, { recursive: true });
    const sizes = {};
    for (const [name, files] of Object.entries(BUNDLES)) {
        const parts = [];
        for (const f of files) {
            const r = await minify(fs.readFileSync(path.join(SRC, f), 'utf8'), {
                compress: { passes: 2 },
                mangle: true,
                format: { comments: false }
            });
            if (!r.code) throw new Error('terser produced no output for ' + f);
            parts.push(r.code);
        }
        const code = parts.join('\n;\n') + '\n';
        fs.writeFileSync(path.join(outDir, name + '.js'), code);
        sizes[name + '.js'] = code.length;
    }
    const css = STYLES.map(f => minifyCss(fs.readFileSync(path.join(SRC, f), 'utf8'))).join('\n');
    fs.writeFileSync(path.join(outDir, 'style.css'), css);
    sizes['style.css'] = css.length;
    return sizes;
}

module.exports = { build, BUNDLES };

if (require.main === module) {
    build().then(
        sizes => console.log('webview bundles:', sizes),
        err => {
            console.error(err);
            process.exit(1);
        }
    );
}

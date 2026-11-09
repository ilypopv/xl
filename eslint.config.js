'use strict';

const js = require('@eslint/js');
const globals = require('globals');

const rules = {
    eqeqeq: ['warn', 'smart'],
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-control-regex': 'off',
    'no-prototype-builtins': 'off',
    'no-useless-escape': 'warn',
    'no-var': 'off',
    'prefer-const': 'off'
};

module.exports = [
    { ignores: ['dist/**', 'node_modules/**', 'out/vendor/**', 'docs/**', '**/*.vsix'] },
    js.configs.recommended,
    {
        // Webview and core modules: plain browser scripts that also load under node for tests.
        files: ['out/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                module: 'writable',
                require: 'readonly',
                OX: 'writable',
                Buffer: 'readonly',
                fflate: 'readonly',
                SSF: 'readonly',
                acquireVsCodeApi: 'readonly',
                // defined by the inline script that the extension host injects into the page
                getOptions: 'readonly',
                ignoreState: 'readonly'
            }
        },
        rules
    },
    {
        // Top-level functions of the page scripts are called from the injected inline script.
        files: ['out/csv.js', 'out/excel.js'],
        rules: { 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', vars: 'local' }] }
    },
    {
        files: ['test/**/*.js', 'scripts/**/*.js', 'webpack.config.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node, SSF: 'readonly', fflate: 'readonly' }
        },
        rules
    }
];

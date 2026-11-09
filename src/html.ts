// JSON for an inline <script>: no sequence in the output can close the script or break the JS string/line grammar.
export function safeJson(value: any): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    const g: any = (globalThis as any).crypto;
    const bytes = new Uint8Array(32);
    if (g && g.getRandomValues) {
        g.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    for (let i = 0; i < bytes.length; i++) {
        out += chars[bytes[i] % chars.length];
    }
    return out;
}

export function csp(cspSource: string, nonce: string): string {
    return `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource}; connect-src ${cspSource};`;
}

export function cleanString(v: any, fallback: string, maxLen: number, minLen = 1): string {
    return typeof v === 'string' && v.length >= minLen && v.length <= maxLen ? v : fallback;
}

export function cleanEnum(v: any, allowed: string[], fallback: string): string {
    return typeof v === 'string' && allowed.indexOf(v) >= 0 ? v : fallback;
}

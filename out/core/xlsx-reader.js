(function (root) {
    'use strict';
    const OX = root.OX || (root.OX = {});

    // zip-bomb guards shared with the writer; override per call (readXlsx opts.limits) or by mutating OX.zipLimits
    const ZIP_BOMB = 'File is too large or looks like a zip bomb';
    OX.ZIP_BOMB_MESSAGE = ZIP_BOMB;
    OX.zipLimits = Object.assign(
        {
            maxEntries: 100000,
            maxTotal: 2 * 1024 ** 3,
            maxPart: 256 * 1024 ** 2,
            maxSheet: 1.5 * 1024 ** 3,
            ratio: 1000,
            ratioMin: 256 * 1024 ** 2,
            lazySst: 2 * 1024 ** 2,
            sstChunk: 65536,
            nativeInflate: 1024 ** 2
        },
        OX.zipLimits
    );
    const bombErr = () => {
        const e = new Error(ZIP_BOMB);
        e.code = 'ZIPBOMB';
        return e;
    };

    // entry count + declared total size from the central directory (zip64 aware); throws on bombs
    function checkZipDir(bytes, L) {
        const n = bytes.length,
            dv = new DataView(bytes.buffer, bytes.byteOffset, n);
        let e = n - 22;
        const lim = Math.max(0, e - 65535);
        for (; e >= lim; e--) if (dv.getUint32(e, true) === 0x06054b50) break;
        if (e < lim) return;
        let cnt = dv.getUint16(e + 10, true),
            p = dv.getUint32(e + 16, true);
        if ((cnt === 0xffff || p === 0xffffffff) && e >= 20 && dv.getUint32(e - 20, true) === 0x07064b50) {
            const zo = dv.getUint32(e - 12, true) + dv.getUint32(e - 8, true) * 4294967296;
            if (zo + 56 <= n && dv.getUint32(zo, true) === 0x06064b50) {
                cnt = dv.getUint32(zo + 32, true) + dv.getUint32(zo + 36, true) * 4294967296;
                p = dv.getUint32(zo + 48, true) + dv.getUint32(zo + 52, true) * 4294967296;
            }
        }
        if (cnt > L.maxEntries) throw bombErr();
        let total = 0;
        for (let k = 0; k < cnt && p + 46 <= n; k++) {
            if (dv.getUint32(p, true) !== 0x02014b50) return;
            const us = dv.getUint32(p + 24, true);
            if (us !== 0xffffffff) {
                if (us > L.maxSheet) throw bombErr();
                total += us;
                if (total > L.maxTotal) throw bombErr();
            }
            p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
        }
    }

    // ---------- small helpers ----------
    const colNameCache = [];
    function colName(c) {
        let s = colNameCache[c];
        if (s !== undefined) return s;
        s = '';
        let n = c + 1;
        while (n > 0) {
            const m = (n - 1) % 26;
            s = String.fromCharCode(65 + m) + s;
            n = (n - 1 - m) / 26;
        }
        return (colNameCache[c] = s);
    }
    function colIndex(letters) {
        let n = 0;
        for (let i = 0; i < letters.length; i++) n = n * 26 + ((letters.charCodeAt(i) | 32) - 96);
        return n - 1;
    }

    const ENT = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
    function entRep(m, g) {
        switch (g) {
            case 'amp':
                return '&';
            case 'lt':
                return '<';
            case 'gt':
                return '>';
            case 'quot':
                return '"';
            case 'apos':
                return "'";
        }
        const n =
            g.charCodeAt(1) === 120 || g.charCodeAt(1) === 88 ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        if (!(n >= 0 && n <= 0x10ffff) || (n >= 0xd800 && n <= 0xdfff)) return '�';
        return String.fromCodePoint(n);
    }
    function xmlDecode(s) {
        return s.indexOf('&') < 0 ? s : s.replace(ENT, entRep);
    }
    const UESC = /_x([0-9A-Fa-f]{4})_/g;
    function uescRep(m, h) {
        return String.fromCharCode(parseInt(h, 16));
    }
    // entity decode + OOXML _xHHHH_ escapes (strings in sharedStrings/inline/str cells)
    function decodeStr(s) {
        if (s.indexOf('&') >= 0) s = s.replace(ENT, entRep);
        if (s.indexOf('_x') >= 0) s = s.replace(UESC, uescRep);
        return s;
    }

    function toText(u8) {
        let i = 0;
        if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) i = 3;
        let s;
        if (typeof TextDecoder !== 'undefined') s = new TextDecoder('utf-8').decode(i ? u8.subarray(i) : u8);
        else s = root.fflate.strFromU8(i ? u8.subarray(i) : u8);
        return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    }

    // remove an element namespace prefix (e.g. <x:row>) so scanners can assume bare names
    function prep(x) {
        let p = 0;
        for (;;) {
            p = x.indexOf('<', p);
            if (p < 0) return x;
            const c = x.charCodeAt(p + 1);
            if (c === 63 || c === 33) {
                p++;
                continue;
            }
            let e = p + 1;
            while (e < x.length) {
                const d = x.charCodeAt(e);
                if (d === 32 || d === 62 || d === 47 || d === 9 || d === 10 || d === 13) break;
                e++;
            }
            const name = x.substring(p + 1, e),
                k = name.indexOf(':');
            if (k < 0) return x;
            const pre = name.substring(0, k + 1);
            return x
                .split('<' + pre)
                .join('<')
                .split('</' + pre)
                .join('</');
        }
    }

    function tagEnd(x, p) {
        let q = 0;
        for (let i = p, n = x.length; i < n; i++) {
            const c = x.charCodeAt(i);
            if (q) {
                if (c === q) q = 0;
            } else if (c === 34 || c === 39) q = c;
            else if (c === 62) return i;
        }
        return -1;
    }

    // parse attributes of a tag text like `<a b="1" c='2'/>` into a plain object
    function attrMap(t) {
        const o = {};
        let i = t.indexOf(' ');
        const n = t.length;
        if (i < 0) return o;
        while (i < n) {
            let c = t.charCodeAt(i);
            if (c <= 32 || c === 47 || c === 62) {
                i++;
                continue;
            }
            const ns = i;
            while (i < n && (c = t.charCodeAt(i)) !== 61 && c > 32 && c !== 62) i++;
            const name = t.substring(ns, i);
            while (i < n && t.charCodeAt(i) <= 32) i++;
            if (t.charCodeAt(i) !== 61) continue;
            i++;
            while (i < n && t.charCodeAt(i) <= 32) i++;
            const q = t.charCodeAt(i);
            if (q !== 34 && q !== 39) continue;
            const e = t.indexOf(q === 34 ? '"' : "'", i + 1);
            if (e < 0) break;
            const v = t.substring(i + 1, e);
            o[name] = v.indexOf('&') >= 0 ? xmlDecode(v) : v;
            i = e + 1;
        }
        return o;
    }

    // iterate elements named `name`: cb(attrs, innerXml)
    function eachElem(x, name, cb) {
        const open = '<' + name,
            ol = open.length,
            close = '</' + name + '>';
        let p = 0;
        for (;;) {
            p = x.indexOf(open, p);
            if (p < 0) return;
            const c = x.charCodeAt(p + ol);
            if (!(c === 32 || c === 62 || c === 47 || c === 10 || c === 13 || c === 9)) {
                p += ol;
                continue;
            }
            const te = tagEnd(x, p);
            if (te < 0) return;
            let inner = '',
                next = te + 1;
            if (x.charCodeAt(te - 1) !== 47) {
                const ce = x.indexOf(close, te + 1);
                if (ce < 0) {
                    inner = x.substring(te + 1);
                    next = x.length;
                } else {
                    inner = x.substring(te + 1, ce);
                    next = ce + close.length;
                }
            }
            cb(attrMap(x.substring(p, te)), inner);
            p = next;
        }
    }
    // first element named `name` -> {a: attrs, inner} or null
    function firstElem(x, name) {
        let r = null;
        const open = '<' + name,
            ol = open.length;
        let p = 0;
        for (;;) {
            p = x.indexOf(open, p);
            if (p < 0) return null;
            const c = x.charCodeAt(p + ol);
            if (!(c === 32 || c === 62 || c === 47 || c === 10 || c === 13 || c === 9)) {
                p += ol;
                continue;
            }
            const te = tagEnd(x, p);
            if (te < 0) return null;
            let inner = '';
            if (x.charCodeAt(te - 1) !== 47) {
                const ce = x.indexOf('</' + name + '>', te + 1);
                inner = ce < 0 ? x.substring(te + 1) : x.substring(te + 1, ce);
            }
            r = { a: attrMap(x.substring(p, te)), inner };
            return r;
        }
    }
    function block(x, name) {
        const f = firstElem(x, name);
        return f ? f.inner : '';
    }
    function relId(a) {
        if (a['r:id'] !== undefined) return a['r:id'];
        for (const k in a) if (k.length > 3 && k.endsWith(':id')) return a[k];
        return a.id;
    }
    const isTrue = v => v === '1' || v === 'true';

    // text of <si>/<is> content: concatenate <t> runs, ignoring phonetic <rPh>
    function siText(x) {
        if (x.indexOf('<rPh') >= 0) {
            let out = '',
                p = 0;
            for (;;) {
                const a = x.indexOf('<rPh', p);
                if (a < 0) {
                    out += x.substring(p);
                    break;
                }
                out += x.substring(p, a);
                const b = x.indexOf('</rPh>', a);
                if (b < 0) break;
                p = b + 6;
            }
            x = out;
        }
        let p = x.indexOf('<t');
        if (p < 0) return '';
        let res = '';
        while (p >= 0) {
            const c = x.charCodeAt(p + 2);
            if (c === 62 || c === 32 || c === 47 || c === 9 || c === 10 || c === 13) {
                const te = x.indexOf('>', p);
                if (te < 0) break;
                if (x.charCodeAt(te - 1) !== 47) {
                    const ce = x.indexOf('</t>', te + 1);
                    if (ce < 0) {
                        res += x.substring(te + 1);
                        break;
                    }
                    res += x.substring(te + 1, ce);
                    p = x.indexOf('<t', ce + 4);
                    continue;
                }
                p = x.indexOf('<t', te + 1);
                continue;
            }
            p = x.indexOf('<t', p + 2);
        }
        return decodeStr(res);
    }

    // ---------- formula reference shifting ----------
    const MAXC = 16384,
        MAXR = 1048576;
    const isLetter = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    const isDigit = c => c >= 48 && c <= 57;
    const isTokCh = c => isLetter(c) || isDigit(c) || c === 95 || c === 46 || c === 36 || c === 92 || c > 127;

    // classify a token: returns object for refs or null. kinds: 1 cell, 2 col-only, 3 row-only
    function classify(tok) {
        let i = 0;
        const n = tok.length;
        let ca = false;
        if (tok.charCodeAt(0) === 36) {
            ca = true;
            i++;
        }
        const ls = i;
        while (i < n && isLetter(tok.charCodeAt(i))) i++;
        const ll = i - ls;
        if (ll > 3) return null;
        if (ll > 0 && i === n) {
            const c = colIndex(tok.substring(ls, i));
            return c < MAXC ? { k: 2, ca, c } : null;
        }
        let ra = false;
        if (ll > 0) {
            if (tok.charCodeAt(i) === 36) {
                ra = true;
                i++;
            }
        } else if (ca) {
            ca = false;
            i = 0;
            if (tok.charCodeAt(0) === 36) {
                ra = true;
                i = 1;
            }
        }
        const ds = i;
        while (i < n && isDigit(tok.charCodeAt(i))) i++;
        if (i !== n || i === ds) return null;
        if (i - ds > 7) return null;
        const r = parseInt(tok.substring(ds), 10) - 1;
        if (r < 0 || r >= MAXR) return null;
        if (ll === 0) return { k: 3, ra, r };
        const c = colIndex(tok.substring(ls, ls + ll));
        return c < MAXC ? { k: 1, ca, c, ra, r } : null;
    }

    // compile formula into literal strings and ref objects
    function compile(f) {
        const parts = [];
        let lit = 0; // start of pending literal
        const n = f.length;
        let i = 0;
        const flush = to => {
            if (to > lit) parts.push(f.substring(lit, to));
        };
        while (i < n) {
            const c = f.charCodeAt(i);
            if (c === 34 || c === 39) {
                // string or quoted sheet name
                i++;
                while (i < n) {
                    if (f.charCodeAt(i) === c) {
                        if (f.charCodeAt(i + 1) === c) i += 2;
                        else break;
                    } else i++;
                }
                i++;
                continue;
            }
            if (c === 91) {
                // [structured ref] / [external]
                let d = 0;
                while (i < n) {
                    const x = f.charCodeAt(i);
                    if (x === 91) d++;
                    else if (x === 93) {
                        d--;
                        if (d === 0) {
                            i++;
                            break;
                        }
                    }
                    i++;
                }
                continue;
            }
            if (isTokCh(c)) {
                const s = i;
                while (i < n && isTokCh(f.charCodeAt(i))) i++;
                const nx = f.charCodeAt(i);
                if (nx === 40 || nx === 33) continue; // function name or sheet name
                // number literal like 1.5 or 1E5
                const tok = f.substring(s, i);
                const first = tok.charCodeAt(0);
                let a = classify(tok);
                if (!a) continue;
                if (a.k === 1) {
                    if (s > 0 && f.charCodeAt(s - 1) === 46) continue;
                    flush(s);
                    parts.push(a);
                    lit = i;
                    continue;
                }
                // col-only / row-only: must be one side of a range
                if (nx === 58) {
                    let j = i + 1;
                    while (j < n && isTokCh(f.charCodeAt(j))) j++;
                    const b = classify(f.substring(i + 1, j));
                    if (b && b.k === a.k && f.charCodeAt(j) !== 40 && f.charCodeAt(j) !== 33) {
                        if (a.k === 3 && isDigit(first) && s > 0 && isTokCh(f.charCodeAt(s - 1))) continue;
                        flush(s);
                        parts.push({ k: a.k + 10, a, b });
                        lit = j;
                        i = j;
                        continue;
                    }
                }
                continue;
            }
            i++;
        }
        flush(n);
        return parts;
    }

    // _xlfn./_xlws./_xlpm. prefixes are file-format artifacts; show clean names
    const XLFN_RE = /_xlfn\._xlws\.|_xlfn\.|_xlws\.|_xlpm\./g;

    function shCol(c, abs, dc) {
        return abs ? c : c + dc;
    }
    function render(parts, dr, dc) {
        let out = '';
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (typeof p === 'string') {
                out += p;
                continue;
            }
            if (p.k === 1) {
                const c = shCol(p.c, p.ca, dc),
                    r = p.ra ? p.r : p.r + dr;
                if (c < 0 || c >= MAXC || r < 0 || r >= MAXR) out += '#REF!';
                else out += (p.ca ? '$' : '') + colName(c) + (p.ra ? '$' : '') + (r + 1);
            } else if (p.k === 12) {
                const a = p.a,
                    b = p.b,
                    c1 = shCol(a.c, a.ca, dc),
                    c2 = shCol(b.c, b.ca, dc);
                if (c1 < 0 || c2 < 0 || c1 >= MAXC || c2 >= MAXC) out += '#REF!';
                else out += (a.ca ? '$' : '') + colName(c1) + ':' + (b.ca ? '$' : '') + colName(c2);
            } else {
                const a = p.a,
                    b = p.b,
                    r1 = a.ra ? a.r : a.r + dr,
                    r2 = b.ra ? b.r : b.r + dr;
                if (r1 < 0 || r2 < 0 || r1 >= MAXR || r2 >= MAXR) out += '#REF!';
                else out += (a.ra ? '$' : '') + (r1 + 1) + ':' + (b.ra ? '$' : '') + (r2 + 1);
            }
        }
        return out;
    }
    let lastF = null,
        lastParts = null;
    function shiftFormula(formula, dRow, dCol) {
        if (!formula || (!dRow && !dCol)) return formula;
        if (formula !== lastF) {
            lastParts = compile(formula);
            lastF = formula;
        }
        return render(lastParts, dRow | 0, dCol | 0);
    }

    // ---------- colors ----------
    const INDEXED = (
        '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
        '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
        '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
        '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333'
    )
        .split(' ')
        .map(h => '#' + h.toLowerCase());
    // order by theme index: lt1 dk1 lt2 dk2 accent1-6 hlink folHlink
    const DEFAULT_THEME = [
        '#ffffff',
        '#000000',
        '#e7e6e6',
        '#44546a',
        '#4472c4',
        '#ed7d31',
        '#a5a5a5',
        '#ffc000',
        '#5b9bd5',
        '#70ad47',
        '#0563c1',
        '#954f72'
    ];

    function hex2(n) {
        n = Math.max(0, Math.min(255, Math.round(n)));
        return (n < 16 ? '0' : '') + n.toString(16);
    }
    function applyTint(hex, tint) {
        if (!tint) return hex;
        const r = parseInt(hex.substr(1, 2), 16) / 255,
            g = parseInt(hex.substr(3, 2), 16) / 255,
            b = parseInt(hex.substr(5, 2), 16) / 255;
        const mx = Math.max(r, g, b),
            mn = Math.min(r, g, b);
        let h = 0,
            s = 0,
            l = (mx + mn) / 2;
        const d = mx - mn;
        if (d > 0) {
            s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
            if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (mx === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h /= 6;
        }
        l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
        l = Math.max(0, Math.min(1, l));
        let R, G, B;
        if (s === 0) R = G = B = l;
        else {
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
                p = 2 * l - q;
            const hue = t => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
            };
            R = hue(h + 1 / 3);
            G = hue(h);
            B = hue(h - 1 / 3);
        }
        return '#' + hex2(R * 255) + hex2(G * 255) + hex2(B * 255);
    }

    function makeColorResolver(theme, indexed) {
        return function (a) {
            if (!a) return null;
            let hex = null;
            if (a.rgb !== undefined) {
                const v = a.rgb;
                if (v.length === 8 || v.length === 6) hex = '#' + v.slice(-6).toLowerCase();
                else return null;
                if (!/^#[0-9a-f]{6}$/.test(hex)) return null;
            } else if (a.theme !== undefined) {
                const i = parseInt(a.theme, 10);
                hex = theme[i] || null;
            } else if (a.indexed !== undefined) {
                const i = parseInt(a.indexed, 10);
                hex = (indexed[i] !== undefined ? indexed[i] : INDEXED[i]) || null;
            } else return null;
            if (hex && a.tint !== undefined) {
                const t = parseFloat(a.tint);
                if (t) hex = applyTint(hex, t);
            }
            return hex;
        };
    }

    function parseTheme(x) {
        const out = DEFAULT_THEME.slice();
        if (!x) return out;
        x = prep(x);
        const names = [
            'lt1',
            'dk1',
            'lt2',
            'dk2',
            'accent1',
            'accent2',
            'accent3',
            'accent4',
            'accent5',
            'accent6',
            'hlink',
            'folHlink'
        ];
        const cs = block(x, 'clrScheme');
        for (let i = 0; i < names.length; i++) {
            const e = firstElem(cs, names[i]);
            if (!e) continue;
            const m = /(?:lastClr|val)="([0-9a-fA-F]{6})"/.exec(e.inner);
            if (m) out[i] = '#' + m[1].toLowerCase();
        }
        return out;
    }

    // ---------- styles ----------
    const BUILTIN_FMT = {
        0: 'General',
        1: '0',
        2: '0.00',
        3: '#,##0',
        4: '#,##0.00',
        5: '"$"#,##0_);\\("$"#,##0\\)',
        6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
        7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
        8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
        9: '0%',
        10: '0.00%',
        11: '0.00E+00',
        12: '# ?/?',
        13: '# ??/??',
        14: 'm/d/yy',
        15: 'd-mmm-yy',
        16: 'd-mmm',
        17: 'mmm-yy',
        18: 'h:mm AM/PM',
        19: 'h:mm:ss AM/PM',
        20: 'h:mm',
        21: 'h:mm:ss',
        22: 'm/d/yy h:mm',
        27: 'm/d/yy',
        28: 'm/d/yy',
        29: 'm/d/yy',
        30: 'm/d/yy',
        31: 'm/d/yy',
        32: 'h:mm:ss',
        33: 'h:mm:ss',
        34: 'h:mm AM/PM',
        35: 'h:mm:ss AM/PM',
        36: 'm/d/yy',
        37: '#,##0 ;(#,##0)',
        38: '#,##0 ;[Red](#,##0)',
        39: '#,##0.00;(#,##0.00)',
        40: '#,##0.00;[Red](#,##0.00)',
        41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
        42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
        43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
        44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
        45: 'mm:ss',
        46: '[h]:mm:ss',
        47: 'mmss.0',
        48: '##0.0E+0',
        49: '@'
    };
    function builtinFmt(id) {
        const t = root.SSF && root.SSF._table;
        const f = (t && t[id]) || BUILTIN_FMT[id] || 'General';
        // Excel shows the locale short date with a 4-digit year for builtin ids; only custom codes keep yy
        return f === 'm/d/yy' || f === 'mm-dd-yy' ? 'm/d/yyyy' : f === 'm/d/yy h:mm' ? 'm/d/yyyy h:mm' : f;
    }

    function defaultStyle() {
        return {
            fmt: 'General',
            b: false,
            i: false,
            u: false,
            strike: false,
            color: null,
            size: 11,
            font: 'Calibri',
            bg: null,
            h: 'general',
            v: 'bottom',
            wrap: false,
            indent: 0,
            bl: null,
            br: null,
            bt: null,
            bb: null
        };
    }

    function flag(inner, tag) {
        const m = inner.indexOf('<' + tag);
        if (m < 0) return false;
        const c = inner.charCodeAt(m + tag.length + 1);
        if (!(c === 32 || c === 47 || c === 62)) return false;
        const te = inner.indexOf('>', m);
        const t = inner.substring(m, te);
        const mm = /val="([^"]*)"/.exec(t);
        if (!mm) return true;
        return !(mm[1] === '0' || mm[1] === 'false' || (tag === 'u' && mm[1] === 'none'));
    }
    function elemAttrs(inner, tag) {
        const e = firstElem(inner, tag);
        return e ? e.a : null;
    }

    function parseStyles(x, resolve, indexedHolder) {
        const result = { styles: [defaultStyle()], defaultFont: { name: 'Calibri', size: 11 } };
        if (!x) return result;
        x = prep(x);
        const custom = {};
        eachElem(block(x, 'numFmts'), 'numFmt', a => {
            if (a.numFmtId !== undefined) custom[a.numFmtId] = a.formatCode || 'General';
        });
        const fonts = [];
        eachElem(block(x, 'fonts'), 'font', (a, inner) => {
            const sz = elemAttrs(inner, 'sz'),
                nm = elemAttrs(inner, 'name');
            fonts.push({
                b: flag(inner, 'b'),
                i: flag(inner, 'i'),
                u: flag(inner, 'u'),
                strike: flag(inner, 'strike'),
                color: resolve(elemAttrs(inner, 'color')),
                size: sz && parseFloat(sz.val) > 0 ? parseFloat(sz.val) : 11,
                name: nm && nm.val ? nm.val : 'Calibri'
            });
        });
        const fills = [];
        eachElem(block(x, 'fills'), 'fill', (a, inner) => {
            let bg = null;
            const pf = firstElem(inner, 'patternFill');
            if (pf) {
                if (pf.a.patternType === 'solid') bg = resolve(elemAttrs(pf.inner, 'fgColor'));
            } else if (inner.indexOf('<gradientFill') >= 0) {
                const st = firstElem(inner, 'stop');
                if (st) bg = resolve(elemAttrs(st.inner, 'color'));
            }
            fills.push(bg);
        });
        const borders = [];
        eachElem(block(x, 'borders'), 'border', (a, inner) => {
            const side = (n1, n2) => {
                let e = firstElem(inner, n1) || (n2 && firstElem(inner, n2));
                if (!e || !e.a.style) return null;
                const col = elemAttrs(e.inner, 'color');
                return { style: e.a.style, color: resolve(col) || '#000000' };
            };
            borders.push({ l: side('left', 'start'), r: side('right', 'end'), t: side('top'), b: side('bottom') });
        });
        const xfs = block(x, 'cellXfs');
        const styles = [];
        eachElem(xfs, 'xf', (a, inner) => {
            const st = defaultStyle();
            const nf = a.numFmtId !== undefined ? parseInt(a.numFmtId, 10) : 0;
            st.fmt = custom[nf] !== undefined ? custom[nf] : builtinFmt(nf);
            const f = fonts[parseInt(a.fontId, 10) || 0];
            if (f) {
                st.b = f.b;
                st.i = f.i;
                st.u = f.u;
                st.strike = f.strike;
                st.color = f.color;
                st.size = f.size;
                st.font = f.name;
            }
            const fl = fills[parseInt(a.fillId, 10) || 0];
            st.bg = fl || null;
            const bd = borders[parseInt(a.borderId, 10) || 0];
            if (bd) {
                st.bl = bd.l;
                st.br = bd.r;
                st.bt = bd.t;
                st.bb = bd.b;
            }
            const al = elemAttrs(inner, 'alignment');
            if (al) {
                if (al.horizontal) st.h = al.horizontal;
                if (al.vertical)
                    st.v = al.vertical === 'justify' || al.vertical === 'distributed' ? 'top' : al.vertical;
                st.wrap = isTrue(al.wrapText);
                st.indent = parseInt(al.indent, 10) || 0;
            }
            styles.push(st);
        });
        if (styles.length) result.styles = styles;
        if (fonts[0]) result.defaultFont = { name: fonts[0].name, size: fonts[0].size };
        return result;
    }

    // ---------- A1 ref parsing ----------
    function parseRange(ref) {
        if (!ref) return null;
        const k = ref.indexOf(':');
        const a = parseCellRef(k < 0 ? ref : ref.substring(0, k)),
            b = k < 0 ? a : parseCellRef(ref.substring(k + 1));
        if (!a || !b) return null;
        return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
    }
    function parseCellRef(s) {
        const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(s.trim());
        if (!m) return null;
        const c = colIndex(m[1]),
            r = parseInt(m[2], 10) - 1;
        return c >= MAXC || r < 0 || r >= MAXR ? null : { c, r };
    }

    // ---------- compact cell store (columnar pages, rows in parse order) ----------
    const PG = 16,
        PSZ = 1 << PG,
        PM = PSZ - 1;
    // type codes: 0 n, 1 s (sst id), 2 s (pool), 3 b, 4 e (pool), 5 d (pool), 6 z
    const FCH = 1 << 20;
    const TCH = ['n', 's', 's', 'b', 'e', 'd', 'z'];

    class SheetStore {
        constructor(sst) {
            this.sst = sst;
            this.n = 0;
            this.cap = 64;
            this.pc = [new Uint16Array(64)];
            this.pt = [new Uint8Array(64)];
            this.ps = [new Int32Array(64)];
            this.pv = [new Float64Array(64)];
            this.pr = null; // per-cell row pages, only while input is out of order
            this.rs = new Int32Array(1024);
            this.lastRow = -1;
            this.lastCol = -1;
            this.pool = [];
            this.masters = [];
            this.fn = 0;
            this.fIdx = new Int32Array(256);
            this.fOff = new Int32Array(256);
            this.fLen = new Int32Array(256);
            this.fch = [];
            this.fcur = '';
            this.fparts = [];
            this.fplen = 0;
        }
        _grow() {
            const g = (A, a, len) => {
                const x = new A(len);
                x.set(a);
                return x;
            };
            if (this.pc.length === 1 && this.pc[0].length < PSZ) {
                const len = Math.min(PSZ, this.pc[0].length * 4);
                this.pc[0] = g(Uint16Array, this.pc[0], len);
                this.pt[0] = g(Uint8Array, this.pt[0], len);
                this.ps[0] = g(Int32Array, this.ps[0], len);
                this.pv[0] = g(Float64Array, this.pv[0], len);
                if (this.pr) this.pr[0] = g(Int32Array, this.pr[0], len);
                this.cap = len;
            } else {
                this.pc.push(new Uint16Array(PSZ));
                this.pt.push(new Uint8Array(PSZ));
                this.ps.push(new Int32Array(PSZ));
                this.pv.push(new Float64Array(PSZ));
                if (this.pr) this.pr.push(new Int32Array(PSZ));
                this.cap += PSZ;
            }
        }
        _unorder() {
            const pr = (this.pr = []);
            for (let k = 0; k < this.pc.length; k++) pr.push(new Int32Array(this.pc[k].length));
            for (let r = 0; r <= this.lastRow; r++) {
                const b = r < this.lastRow ? this.rs[r + 1] : this.n;
                for (let i = this.rs[r]; i < b; i++) pr[i >>> PG][i & PM] = r;
            }
        }
        add(r, c, tc, s, v) {
            if (this.pr === null) {
                if (r === this.lastRow) {
                    if (c <= this.lastCol) this._unorder();
                } else if (r > this.lastRow) {
                    if (r + 2 >= this.rs.length) {
                        const x = new Int32Array(Math.max(r + 2, this.rs.length * 2) + 1024);
                        x.set(this.rs);
                        this.rs = x;
                    }
                    const rs = this.rs,
                        n = this.n;
                    for (let k = this.lastRow + 1; k <= r; k++) rs[k] = n;
                    this.lastRow = r;
                    this.lastCol = -1;
                } else this._unorder();
                this.lastCol = c;
            }
            const i = this.n;
            if (i >= this.cap) this._grow();
            const pg = i >>> PG,
                o = i & PM;
            this.pc[pg][o] = c;
            this.pt[pg][o] = tc;
            this.ps[pg][o] = s;
            this.pv[pg][o] = v;
            if (this.pr !== null) this.pr[pg][o] = r;
            this.n = i + 1;
            return i;
        }
        // formulas: ascending cell ids + offsets into shared text chunks (len -1: shared-formula master id in off, -2: pool string)
        setF(i, f) {
            let n = this.fn;
            if (n === this.fIdx.length) {
                const g = a => {
                    const x = new Int32Array(n * 2);
                    x.set(a);
                    return x;
                };
                this.fIdx = g(this.fIdx);
                this.fOff = g(this.fOff);
                this.fLen = g(this.fLen);
            }
            let off, len;
            if (typeof f !== 'string') {
                off = f;
                len = -1;
            } else if (this.fch.length >= 2000) {
                off = this.pool.push(f) - 1;
                len = -2;
            } else {
                if (this.fcur.length + this.fplen + f.length > FCH) {
                    this._fflush();
                    this.fch.push(this.fcur);
                    this.fcur = '';
                }
                off = this.fch.length * FCH + this.fcur.length + this.fplen;
                len = f.length;
                this.fparts.push(f);
                this.fplen += f.length;
                if (this.fparts.length >= 8192) this._fflush();
            }
            this.fIdx[n] = i;
            this.fOff[n] = off;
            this.fLen[n] = len;
            this.fn = n + 1;
        }
        _fflush() {
            if (this.fparts.length) {
                this.fcur += this.fparts.join('');
                this.fparts = [];
                this.fplen = 0;
            }
        }
        // raw formula slot of cell i: string, shared master id (number) or undefined
        fget(i) {
            let lo = 0,
                hi = this.fn - 1;
            const fi = this.fIdx;
            while (lo <= hi) {
                const m = (lo + hi) >>> 1,
                    x = fi[m];
                if (x === i) {
                    const len = this.fLen[m],
                        off = this.fOff[m];
                    if (len === -1) return off;
                    if (len === -2) return this.pool[off];
                    if (len === 0) return '';
                    if (this.fplen) this._fflush();
                    const k = Math.floor(off / FCH),
                        p = off - k * FCH,
                        src = k < this.fch.length ? this.fch[k] : this.fcur;
                    return src.substring(p, p + len);
                }
                if (x < i) lo = m + 1;
                else hi = m - 1;
            }
            return undefined;
        }
        // index of cell (r,c) or -1
        index(r, c) {
            if (r > this.lastRow || r < 0 || this.pr !== null) return -1;
            const a = this.rs[r],
                b = r < this.lastRow ? this.rs[r + 1] : this.n;
            if (a === b) return -1;
            const pc = this.pc;
            if (b - a <= 8) {
                for (let i = a; i < b; i++) {
                    const x = pc[i >>> PG][i & PM];
                    if (x === c) return i;
                    if (x > c) return -1;
                }
                return -1;
            }
            let lo = a,
                hi = b - 1;
            while (lo <= hi) {
                const m = (lo + hi) >>> 1,
                    x = pc[m >>> PG][m & PM];
                if (x === c) return m;
                if (x < c) lo = m + 1;
                else hi = m - 1;
            }
            return -1;
        }
        cellAt(i, r, c) {
            const pg = i >>> PG,
                o = i & PM;
            const tc = this.pt[pg][o],
                s = this.ps[pg][o],
                v = this.pv[pg][o];
            let val;
            switch (tc) {
                case 0:
                    val = v;
                    break;
                case 1:
                    val = this.sst.get(v);
                    break;
                case 2:
                case 4:
                case 5:
                    val = this.pool[v];
                    break;
                case 3:
                    val = v === 1;
                    break;
                default:
                    val = null;
            }
            if (this.fn !== 0) {
                const f = this.fget(i);
                if (f !== undefined)
                    return { t: TCH[tc], v: val, s, f: typeof f === 'string' ? f : this._shared(f, r, c) };
            }
            return { t: TCH[tc], v: val, s };
        }
        _shared(id, r, c) {
            const m = this.masters[id];
            return m ? shiftFormula(m.f, r - m.r, c - m.c) : '';
        }
        get(r, c) {
            const i = this.index(r, c);
            return i < 0 ? undefined : this.cellAt(i, r, c);
        }
        // fn(cell, r, c) in row-major order for cells inside the rectangle
        each(r1, c1, r2, c2, fn) {
            if (this.pr !== null) return;
            const last = Math.min(r2, this.lastRow),
                pc = this.pc;
            for (let r = Math.max(0, r1); r <= last; r++) {
                const b = r < this.lastRow ? this.rs[r + 1] : this.n;
                for (let i = this.rs[r]; i < b; i++) {
                    const c = pc[i >>> PG][i & PM];
                    if (c < c1) continue;
                    if (c > c2) break;
                    fn(this.cellAt(i, r, c), r, c);
                }
            }
        }
        // sort out-of-order input into row-major order (later duplicates win)
        finalize() {
            if (this.pr === null) return;
            const n = this.n,
                keys = new Float64Array(n),
                pr = this.pr,
                pc = this.pc;
            for (let i = 0; i < n; i++) keys[i] = pr[i >>> PG][i & PM] * 16384 + pc[i >>> PG][i & PM];
            const idx = new Int32Array(n);
            for (let i = 0; i < n; i++) idx[i] = i;
            idx.sort((a, b) => keys[a] - keys[b] || a - b);
            const o = new SheetStore(this.sst);
            o.pool = this.pool;
            o.masters = this.masters;
            for (let k = 0; k < n; k++) {
                const i = idx[k];
                if (k + 1 < n && keys[idx[k + 1]] === keys[i]) continue;
                const pg = i >>> PG,
                    of = i & PM,
                    key = keys[i],
                    r = Math.floor(key / 16384);
                const j = o.add(r, key - r * 16384, this.pt[pg][of], this.ps[pg][of], this.pv[pg][of]);
                if (this.fn !== 0) {
                    const f = this.fget(i);
                    if (f !== undefined) o.setF(j, f);
                }
            }
            for (const k of [
                'n',
                'cap',
                'pc',
                'pt',
                'ps',
                'pv',
                'pr',
                'rs',
                'lastRow',
                'lastCol',
                'fn',
                'fIdx',
                'fOff',
                'fLen',
                'fch',
                'fcur',
                'fparts',
                'fplen'
            ])
                this[k] = o[k];
        }
    }

    // legacy sheet.rows[r][c] view, built on demand (tests and tools; the provider reads the store)
    function legacyRows(st) {
        const rows = [];
        if (st.pr !== null) return rows;
        for (let r = 0; r <= st.lastRow; r++) {
            const a = st.rs[r],
                b = r < st.lastRow ? st.rs[r + 1] : st.n;
            if (a === b) continue;
            const arr = [];
            for (let i = a; i < b; i++) {
                const c = st.pc[i >>> PG][i & PM];
                arr[c] = st.cellAt(i, r, c);
            }
            rows[r] = arr;
        }
        return rows;
    }

    // lazily decoded shared string table (offsets only; strings materialize on first use)
    function makeSst(x) {
        let st = new Int32Array(1024),
            en = new Int32Array(1024),
            n = 0;
        const put = (a, b) => {
            if (n === st.length) {
                const s2 = new Int32Array(n * 2),
                    e2 = new Int32Array(n * 2);
                s2.set(st);
                e2.set(en);
                st = s2;
                en = e2;
            }
            st[n] = a;
            en[n] = b;
            n++;
        };
        let p = 0;
        for (;;) {
            p = x.indexOf('<si', p);
            if (p < 0) break;
            const c = x.charCodeAt(p + 3);
            if (!(c === 62 || c === 32 || c === 47)) {
                p += 3;
                continue;
            }
            const te = x.indexOf('>', p);
            if (te < 0) break;
            if (x.charCodeAt(te - 1) === 47) {
                put(0, 0);
                p = te + 1;
                continue;
            }
            const ce = x.indexOf('</si>', te + 1);
            const e = ce < 0 ? x.length : ce;
            put(te + 1, e);
            p = e + 5;
        }
        const cache = new Array(n);
        return {
            length: n,
            has: i => i >= 0 && i < n,
            get(i) {
                let v = cache[i];
                if (v !== undefined) return v;
                if (!(i >= 0 && i < n)) return '';
                const a = st[i],
                    b = en[i];
                v = sstValue(x, a, b);
                return (cache[i] = v);
            }
        };
    }

    function sstValue(x, a, b) {
        if (a === b) return '';
        if (
            x.charCodeAt(a) === 60 &&
            x.charCodeAt(a + 1) === 116 &&
            x.charCodeAt(a + 2) === 62 &&
            x.indexOf('</t>', a + 3) === b - 4 &&
            x.indexOf('<', a + 3) === b - 4
        )
            return decodeStr(x.substring(a + 3, b - 4));
        return siText(x.substring(a, b));
    }

    // Same contract as makeSst, but the raw-deflate payload is inflated and indexed on demand, only as far as the
    // highest string id asked for, so a huge sharedStrings part no longer delays the first paint.
    // Returns null when the part is not a plain unprefixed <sst> (the caller then takes the eager path).
    function makeLazySst(data, L, fl) {
        const td = new TextDecoder('utf-8');
        const chunks = [];
        let n = 0,
            carry = '',
            pos = 0,
            got = 0,
            done = false,
            failed = null,
            parts = [],
            probed = false,
            prefixed = false;
        const inf = new fl.Inflate(c => {
            got += c.length;
            if (got > L.maxPart || (got > L.ratioMin && got > L.ratio * Math.max(1, pos))) throw bombErr();
            if (c.length) parts.push(td.decode(c, { stream: true }));
        });
        function index(text, final) {
            const st = [],
                en = [];
            const len = text.length;
            let p = 0,
                keep = len;
            for (;;) {
                const q = text.indexOf('<si', p);
                if (q < 0) {
                    keep = Math.max(p, len - 2);
                    break;
                }
                if (q + 3 >= len) {
                    keep = q;
                    break;
                }
                const c = text.charCodeAt(q + 3);
                if (!(c === 62 || c === 32 || c === 47)) {
                    p = q + 3;
                    continue;
                }
                const te = text.indexOf('>', q);
                if (te < 0) {
                    keep = q;
                    break;
                }
                if (text.charCodeAt(te - 1) === 47) {
                    st.push(0);
                    en.push(0);
                    p = te + 1;
                    continue;
                }
                const ce = text.indexOf('</si>', te + 1);
                if (ce < 0) {
                    if (final) {
                        st.push(te + 1);
                        en.push(len);
                        keep = len;
                    } else keep = q;
                    break;
                }
                st.push(te + 1);
                en.push(ce);
                p = ce + 5;
            }
            carry = final ? '' : text.substring(keep);
            if (st.length) {
                chunks.push({ text, first: n, st: Int32Array.from(st), en: Int32Array.from(en), cache: null });
                n += st.length;
            }
        }
        function probe(text, last) {
            // prep() strips a namespace prefix decided by the first element only
            let q = 0;
            for (;;) {
                q = text.indexOf('<', q);
                if (q < 0) return last;
                const c = text.charCodeAt(q + 1);
                if (c === 63 || c === 33) {
                    q++;
                    continue;
                }
                let e = q + 1;
                while (e < text.length) {
                    const d = text.charCodeAt(e);
                    if (d === 32 || d === 62 || d === 47 || d === 9 || d === 10 || d === 13) break;
                    e++;
                }
                if (e >= text.length && !last) return false;
                prefixed = text.substring(q + 1, e).indexOf(':') >= 0;
                return true;
            }
        }
        function step() {
            if (failed) throw failed;
            if (done) return;
            try {
                const from = pos,
                    end = Math.min(data.length, pos + L.sstChunk),
                    last = end >= data.length;
                pos = end;
                parts = [];
                inf.push(data.subarray(from, end), last);
                if (last) parts.push(td.decode());
                const text = carry + parts.join('');
                parts = [];
                if (!probed) probed = probe(text, last);
                if (prefixed) {
                    done = true;
                    return;
                }
                index(text, last);
                if (last) done = true;
            } catch (e) {
                failed = e;
                done = true;
                throw e;
            }
        }
        while (!probed && !done) step();
        if (prefixed) return null;
        return {
            get length() {
                while (!done) step();
                return n;
            },
            has(i) {
                if (!(i >= 0)) return false;
                while (i >= n && !done) step();
                return i < n;
            },
            get(i) {
                if (!(i >= 0 && i < n)) return '';
                let lo = 0,
                    hi = chunks.length - 1;
                while (lo < hi) {
                    const mid = (lo + hi + 1) >> 1;
                    if (chunks[mid].first <= i) lo = mid;
                    else hi = mid - 1;
                }
                const ch = chunks[lo],
                    k = i - ch.first;
                if (ch.cache === null) ch.cache = new Array(ch.st.length);
                let v = ch.cache[k];
                if (v === undefined) v = ch.cache[k] = sstValue(ch.text, ch.st[k], ch.en[k]);
                return v;
            }
        };
    }

    // ---------- sheet parsing ----------
    function emptySheet(info) {
        return {
            info,
            rows: [],
            store: null,
            partial: false,
            rowCount: 0,
            colCount: 0,
            defaultColWidth: 64,
            defaultRowHeight: 20,
            colWidths: new Map(),
            rowHeights: new Map(),
            hiddenCols: new Set(),
            hiddenRows: new Set(),
            merges: [],
            frozenRows: 0,
            frozenCols: 0,
            showGridLines: true,
            zoomScale: 100,
            dimension: null,
            hyperlinks: new Map(),
            autoFilter: null,
            condFormats: [],
            colStyles: [],
            rowStyles: new Map(),
            zeroHeightRows: false,
            shownRows: null,
            arrays: [],
            tables: [],
            pictures: [],
            warning: null
        };
    }

    // copy so a short slice does not pin the decoded chunk it came from
    const flat = v => (v.length < 13 ? v : (' ' + v).slice(1));
    const NOATTR = Object.freeze({});
    const SHEET_KIND = /^\s*(<\?[^>]*\?>\s*)?<(\w+:)?(chartsheet|dialogsheet)[\s>]/;

    // namespace prefix of the root element ('x:' for <x:worksheet>), null if none, undefined if not decidable yet
    function detectPrefix(x) {
        let p = 0;
        for (;;) {
            p = x.indexOf('<', p);
            if (p < 0) return undefined;
            const c = x.charCodeAt(p + 1);
            if (c === 63 || c === 33) {
                p++;
                continue;
            }
            let e = p + 1;
            while (e < x.length) {
                const d = x.charCodeAt(e);
                if (d === 32 || d === 62 || d === 47 || d === 9 || d === 10 || d === 13) break;
                e++;
            }
            if (e >= x.length) return undefined;
            const name = x.substring(p + 1, e),
                k = name.indexOf(':');
            return k < 0 ? null : name.substring(0, k + 1);
        }
    }

    // Incremental sheet parser: feed(text, final) with arbitrary chunk boundaries; result in .sheet (partial until final).
    function createSheetParser(info, ctx, relsXml) {
        const sh = emptySheet(info);
        const store = new SheetStore(ctx.sst);
        sh.store = store;
        sh.partial = true;
        let legacy = null;
        Object.defineProperty(sh, 'rows', {
            configurable: true,
            enumerable: true,
            get() {
                if (legacy) return legacy;
                const r = legacyRows(store);
                if (!sh.partial) legacy = r;
                return r;
            }
        });
        let phase = 0; // 0 head, 1 sheetData, 2 tail, 3 ignored (chart/dialog sheet)
        let hold = '',
            headBuf = '',
            carry = '',
            postBuf = '',
            searchFrom = 0;
        let detected = false,
            pre = null;
        const sharedIds = new Map();
        let curRowCtx = 0,
            nextCol = 0,
            lastRowIdx = -1,
            rowCount = 0,
            colCount = 0,
            emptyStr = -1;
        const defRowPx = () => sh.defaultRowHeight;

        function parseHead(head) {
            const tc = firstElem(head, 'tabColor');
            if (tc) info.tabColor = ctx.resolve(tc.a) || info.tabColor;
            const dim = firstElem(head, 'dimension');
            if (dim) sh.dimension = parseRange(dim.a.ref);
            const sv = firstElem(head, 'sheetView');
            if (sv) {
                if (sv.a.showGridLines === '0' || sv.a.showGridLines === 'false') sh.showGridLines = false;
                if (sv.a.zoomScale) sh.zoomScale = parseFloat(sv.a.zoomScale) || 100;
                const pn = firstElem(sv.inner, 'pane');
                if (pn && (pn.a.state === 'frozen' || pn.a.state === 'frozenSplit')) {
                    sh.frozenCols = Math.max(0, Math.floor(parseFloat(pn.a.xSplit) || 0));
                    sh.frozenRows = Math.max(0, Math.floor(parseFloat(pn.a.ySplit) || 0));
                }
            }
            const fp = firstElem(head, 'sheetFormatPr');
            if (fp) {
                const d = parseFloat(fp.a.defaultColWidth),
                    bw = parseFloat(fp.a.baseColWidth),
                    rh = parseFloat(fp.a.defaultRowHeight);
                if (d > 0) sh.defaultColWidth = Math.round(d * 7);
                else if (bw > 0 && bw !== 8) sh.defaultColWidth = Math.ceil((bw * 7 + 5) / 8) * 8;
                if (rh > 0) sh.defaultRowHeight = Math.round(((rh * 4) / 3) * 100) / 100;
                if (isTrue(fp.a.zeroHeight)) {
                    sh.zeroHeightRows = true;
                    sh.shownRows = new Set();
                }
            }
            eachElem(block(head, 'cols'), 'col', a => {
                let min = parseInt(a.min, 10),
                    max = parseInt(a.max, 10);
                if (!(min >= 1)) return;
                if (!(max >= min)) max = min;
                if (max > MAXC) max = MAXC;
                const w = parseFloat(a.width),
                    hid = isTrue(a.hidden),
                    cst = parseInt(a.style, 10);
                if (cst > 0) sh.colStyles.push({ c1: min - 1, c2: max - 1, s: cst });
                const px = w >= 0 ? Math.round(w * 7) : -1;
                for (let c = min - 1; c < max; c++) {
                    if (px >= 0) sh.colWidths.set(c, px);
                    if (hid) sh.hiddenCols.add(c);
                }
            });
        }

        function parsePost(post) {
            eachElem(post, 'mergeCell', a => {
                const r = parseRange(a.ref);
                if (r && (r.r1 !== r.r2 || r.c1 !== r.c2)) sh.merges.push(r);
            });
            const af = firstElem(post, 'autoFilter');
            if (af) sh.autoFilter = parseRange(af.a.ref);
            const hls = block(post, 'hyperlinks');
            if (hls) {
                let rels = null;
                eachElem(hls, 'hyperlink', a => {
                    const rg = parseRange(a.ref);
                    if (!rg) return;
                    const link = {};
                    const id = relId(a);
                    if (id !== undefined) {
                        if (!rels) {
                            rels = {};
                            if (relsXml)
                                eachElem(prep(relsXml), 'Relationship', ra => {
                                    rels[ra.Id] = ra;
                                });
                        }
                        if (rels[id] && rels[id].Target && !/^\s*(?:javascript|data|vbscript):/i.test(rels[id].Target))
                            link.url = rels[id].Target;
                    }
                    if (a.location) link.location = a.location;
                    if (a.tooltip) link.tooltip = a.tooltip;
                    if (link.url === undefined && link.location === undefined) return;
                    const cnt = (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1);
                    if (cnt > 10000) sh.hyperlinks.set(rg.r1 + ',' + rg.c1, link);
                    else
                        for (let r = rg.r1; r <= rg.r2; r++)
                            for (let c = rg.c1; c <= rg.c2; c++) sh.hyperlinks.set(r + ',' + c, link);
                });
            }
        }

        // scans complete elements of `s` starting at 0; returns the offset to resume from (rest is carried)
        function scan(s, final) {
            const n = s.length,
                pool = store.pool,
                sst = ctx.sst;
            let pos = 0;
            let aR = -1,
                aC = -1,
                aS = 0,
                aT = 0,
                aTl = 0;
            function cellAttrs(i, end) {
                aR = -1;
                aC = -1;
                aS = 0;
                aT = 0;
                aTl = 0;
                while (i < end) {
                    let ch = s.charCodeAt(i);
                    if (ch <= 32 || ch === 47) {
                        i++;
                        continue;
                    }
                    const ns = i;
                    while (i < end && (ch = s.charCodeAt(i)) !== 61 && ch > 32) i++;
                    const nl = i - ns;
                    while (i < end && s.charCodeAt(i) <= 32) i++;
                    if (s.charCodeAt(i) !== 61) continue;
                    i++;
                    while (i < end && s.charCodeAt(i) <= 32) i++;
                    const q = s.charCodeAt(i);
                    if (q !== 34 && q !== 39) continue;
                    const vs = i + 1;
                    const ve = s.indexOf(q === 34 ? '"' : "'", vs);
                    if (ve < 0 || ve > end) return;
                    if (nl === 1) {
                        const nc = s.charCodeAt(ns);
                        if (nc === 114) {
                            // r
                            let j = vs,
                                col = 0;
                            while (j < ve) {
                                const d = s.charCodeAt(j) | 32;
                                if (d >= 97 && d <= 122) {
                                    col = col * 26 + d - 96;
                                    j++;
                                } else if (s.charCodeAt(j) === 36) j++;
                                else break;
                            }
                            let row = 0;
                            while (j < ve) {
                                const d = s.charCodeAt(j);
                                if (d >= 48 && d <= 57) row = row * 10 + d - 48;
                                else if (d !== 36) break;
                                j++;
                            }
                            if (col > 0 && row > 0) {
                                aC = col - 1;
                                aR = row - 1;
                            }
                        } else if (nc === 115) {
                            // s
                            let v = 0;
                            for (let j = vs; j < ve; j++) {
                                const d = s.charCodeAt(j) - 48;
                                if (d < 0 || d > 9) {
                                    v = 0;
                                    break;
                                }
                                v = v * 10 + d;
                            }
                            aS = v;
                        } else if (nc === 116) {
                            aT = ve > vs ? s.charCodeAt(vs) : 0;
                            aTl = ve - vs;
                        }
                    }
                    i = ve + 1;
                }
            }

            for (;;) {
                const lt = s.indexOf('<', pos);
                if (lt < 0) {
                    pos = n;
                    break;
                }
                if (!final && lt + 12 > n) {
                    pos = lt;
                    break;
                }
                const c1 = s.charCodeAt(lt + 1);
                if (c1 === 99) {
                    // <c
                    const c2 = s.charCodeAt(lt + 2);
                    if (c2 !== 32 && c2 !== 62 && c2 !== 47 && c2 !== 10 && c2 !== 13 && c2 !== 9) {
                        pos = lt + 2;
                        continue;
                    }
                    const te = s.indexOf('>', lt + 2);
                    if (te < 0) {
                        pos = final ? n : lt;
                        break;
                    }
                    const selfClose = s.charCodeAt(te - 1) === 47;
                    let close = te + 1;
                    if (!selfClose) {
                        close = s.indexOf('</c>', te + 1);
                        if (close < 0) {
                            if (!final) {
                                pos = lt;
                                break;
                            }
                            close = n;
                        }
                    }
                    cellAttrs(lt + 2, te);
                    const r = aR >= 0 ? aR : curRowCtx;
                    const c = aC >= 0 ? aC : nextCol;
                    nextCol = c + 1;
                    const st = aS,
                        tc = aT,
                        tl = aTl;
                    let vS = -1,
                        vE = -1,
                        fS = -1,
                        fE = -1,
                        fAttr = null,
                        isS = -1,
                        isE = -1;
                    if (!selfClose) {
                        // fast path: <v>..</v></c>
                        if (
                            s.charCodeAt(te + 1) === 60 &&
                            s.charCodeAt(te + 2) === 118 &&
                            s.charCodeAt(te + 3) === 62
                        ) {
                            vS = te + 4;
                            vE = s.indexOf('</v>', vS);
                            if (vE < 0 || vE + 4 !== close) {
                                vS = -1;
                                vE = -1;
                            }
                        }
                        if (vS < 0) {
                            let p = te + 1;
                            while (p < close) {
                                const l = s.indexOf('<', p);
                                if (l < 0 || l >= close) break;
                                const ch = s.charCodeAt(l + 1),
                                    nx = s.charCodeAt(l + 2);
                                if (ch === 118 && (nx === 62 || nx === 32 || nx === 47)) {
                                    // v
                                    const e = s.indexOf('>', l);
                                    if (s.charCodeAt(e - 1) === 47) {
                                        vS = vE = e;
                                        p = e + 1;
                                    } else {
                                        vS = e + 1;
                                        vE = s.indexOf('</v>', vS);
                                        if (vE < 0 || vE > close) vE = close;
                                        p = vE + 4;
                                    }
                                } else if (ch === 102 && (nx === 62 || nx === 32 || nx === 47)) {
                                    // f
                                    const e = tagEnd(s, l);
                                    if (e < 0) break;
                                    fAttr = e - l === 2 ? NOATTR : attrMap(s.substring(l, e));
                                    if (s.charCodeAt(e - 1) === 47) {
                                        fS = fE = e;
                                        p = e + 1;
                                    } else {
                                        fS = e + 1;
                                        fE = s.indexOf('</f>', fS);
                                        if (fE < 0 || fE > close) fE = close;
                                        p = fE + 4;
                                    }
                                } else if (ch === 105 && nx === 115) {
                                    // is
                                    const e = s.indexOf('>', l);
                                    if (s.charCodeAt(e - 1) === 47) {
                                        p = e + 1;
                                        continue;
                                    }
                                    isS = e + 1;
                                    isE = s.indexOf('</is>', isS);
                                    if (isE < 0 || isE > close) isE = close;
                                    p = isE + 5;
                                } else p = l + 1;
                            }
                        }
                    }
                    pos = close;

                    // formula: explicit text, or (number) id of a shared-formula master expanded on demand
                    let f;
                    if (fS >= 0) {
                        let txt = fE > fS ? s.substring(fS, fE) : '';
                        if (txt.length) {
                            if (txt.charCodeAt(0) === 60 && txt.startsWith('<![CDATA['))
                                txt = txt.substring(9, txt.endsWith(']]>') ? txt.length - 3 : txt.length);
                            else if (txt.indexOf('&') >= 0) txt = xmlDecode(txt);
                            if (txt.indexOf('_xl') >= 0) txt = txt.replace(XLFN_RE, '');
                        }
                        const ft = fAttr.t;
                        if (ft === 'array' && fAttr.ref) {
                            const ar = parseRange(fAttr.ref);
                            if (ar) {
                                ar.mr = r;
                                ar.mc = c;
                                sh.arrays.push(ar);
                            }
                        }
                        if (ft === 'shared' && fAttr.si !== undefined) {
                            let id = sharedIds.get(fAttr.si);
                            if (id === undefined) {
                                id = store.masters.length;
                                store.masters.push(null);
                                sharedIds.set(fAttr.si, id);
                            }
                            if (txt) {
                                store.masters[id] = { f: flat(txt), r, c };
                                f = txt;
                            } else f = id;
                        } else f = txt;
                    }

                    // value
                    let tcode = 0,
                        val = 0;
                    if (vS >= 0 && vE > vS) {
                        switch (
                            tc === 115 && tl === 1
                                ? 1
                                : tc === 115
                                  ? 2
                                  : tc === 105
                                    ? 3
                                    : tc === 98
                                      ? 4
                                      : tc === 101
                                        ? 5
                                        : tc === 100
                                          ? 6
                                          : 0
                        ) {
                            case 1: {
                                let idx = 0,
                                    ok = true;
                                for (let j = vS; j < vE; j++) {
                                    const d = s.charCodeAt(j) - 48;
                                    if (d < 0 || d > 9) {
                                        ok = false;
                                        break;
                                    }
                                    idx = idx * 10 + d;
                                }
                                if (!ok) idx = parseInt(s.substring(vS, vE), 10);
                                if (sst.has(idx)) {
                                    tcode = 1;
                                    val = idx;
                                } else {
                                    tcode = 2;
                                    if (emptyStr < 0) emptyStr = pool.push('') - 1;
                                    val = emptyStr;
                                }
                                break;
                            }
                            case 2:
                            case 3:
                                tcode = 2;
                                val = pool.push(flat(decodeStr(s.substring(vS, vE)))) - 1;
                                break;
                            case 4:
                                tcode = 3;
                                {
                                    const d = s.charCodeAt(vS);
                                    val = d === 49 || d === 116 || d === 84 ? 1 : 0;
                                }
                                break;
                            case 5:
                                tcode = 4;
                                val = pool.push(flat(xmlDecode(s.substring(vS, vE)))) - 1;
                                break;
                            case 6:
                                tcode = 5;
                                val = pool.push(flat(s.substring(vS, vE).trim())) - 1;
                                break;
                            default: {
                                let x = 0,
                                    ok = vE - vS <= 15;
                                if (ok)
                                    for (let j = vS; j < vE; j++) {
                                        const d = s.charCodeAt(j) - 48;
                                        if (d < 0 || d > 9) {
                                            ok = false;
                                            break;
                                        }
                                        x = x * 10 + d;
                                    }
                                if (ok) {
                                    val = x;
                                    break;
                                }
                                const txt = s.substring(vS, vE);
                                x = Number(txt);
                                if (x !== x || txt.trim() === '') {
                                    const pf = parseFloat(txt);
                                    if (pf === pf) x = pf;
                                    else {
                                        tcode = 2;
                                        val = pool.push(flat(decodeStr(txt))) - 1;
                                        break;
                                    }
                                }
                                val = x;
                            }
                        }
                    } else if (isS >= 0 && tc === 105) {
                        tcode = 2;
                        val = pool.push(flat(siText(s.substring(isS, isE)))) - 1;
                    } else if (tc === 105 || (tc === 115 && tl === 3)) {
                        if (tc === 105 && f === undefined && !st) continue;
                        tcode = 2;
                        if (emptyStr < 0) emptyStr = pool.push('') - 1;
                        val = emptyStr;
                    } else {
                        if (f === undefined && !st) continue;
                        tcode = 6;
                    }
                    if (r > 1048575 || c > 16383) continue;
                    const idx = store.add(r, c, tcode, st, val);
                    if (f !== undefined) store.setF(idx, f);
                    if (r >= rowCount) rowCount = r + 1;
                    if (c >= colCount) colCount = c + 1;
                } else if (c1 === 114 && s.charCodeAt(lt + 2) === 111 && s.charCodeAt(lt + 3) === 119) {
                    // <row
                    const te = tagEnd(s, lt);
                    if (te < 0) {
                        pos = final ? n : lt;
                        break;
                    }
                    const a = attrMap(s.substring(lt, te));
                    const rn = parseInt(a.r, 10);
                    const ri = rn >= 1 ? rn - 1 : lastRowIdx + 1;
                    lastRowIdx = ri;
                    curRowCtx = ri;
                    nextCol = 0;
                    if (a.ht !== undefined) {
                        const px = Math.round((parseFloat(a.ht) * 400) / 3) / 100;
                        if (px >= 0 && (isTrue(a.customHeight) || Math.abs(px - defRowPx()) > 0.5))
                            sh.rowHeights.set(ri, px);
                    }
                    if (isTrue(a.hidden)) sh.hiddenRows.add(ri);
                    else if (sh.shownRows !== null) sh.shownRows.add(ri);
                    if (a.s !== undefined && isTrue(a.customFormat)) {
                        const rs = parseInt(a.s, 10);
                        if (rs > 0) sh.rowStyles.set(ri, rs);
                    }
                    pos = te + 1;
                } else if (c1 === 47 && s.startsWith('</sheetData', lt)) {
                    phase = 2;
                    postBuf = s.substring(lt);
                    pos = n;
                    break;
                } else pos = lt + 1;
            }
            sh.rowCount = rowCount;
            sh.colCount = colCount;
            return pos;
        }

        function feed(text, final) {
            if (phase === 3) return;
            if (hold) {
                text = hold + text;
                hold = '';
            }
            if (!final) {
                const k = text.lastIndexOf('>');
                if (k < 0) {
                    hold = text;
                    return;
                }
                if (k < text.length - 1) {
                    hold = text.substring(k + 1);
                    text = text.substring(0, k + 1);
                }
            }
            if (!detected) {
                if (text.charCodeAt(0) === 0xfeff) text = text.substring(1);
                const p = detectPrefix(text);
                if (p === undefined && !final) {
                    hold = text + hold;
                    return;
                }
                detected = true;
                pre = p || null;
                if (SHEET_KIND.test(text.substring(0, 400))) {
                    phase = 3;
                    sh.partial = false;
                    return;
                }
            }
            if (pre !== null)
                text = text
                    .split('<' + pre)
                    .join('<')
                    .split('</' + pre)
                    .join('</');
            const entry = phase;
            if (phase === 0) {
                headBuf = headBuf ? headBuf + text : text;
                text = '';
                const sd = headBuf.indexOf('<sheetData', searchFrom);
                if (sd < 0) {
                    searchFrom = Math.max(0, headBuf.length - 10);
                    if (final) {
                        parseHead(headBuf);
                        headBuf = '';
                        phase = 2;
                    }
                } else {
                    const te = headBuf.indexOf('>', sd);
                    if (te < 0 && !final) searchFrom = sd;
                    else {
                        parseHead(headBuf.substring(0, sd));
                        if (te < 0) {
                            phase = 2;
                            postBuf = '';
                        } else if (headBuf.charCodeAt(te - 1) === 47) {
                            phase = 2;
                            postBuf = headBuf.substring(te + 1);
                        } else {
                            phase = 1;
                            text = headBuf.substring(te + 1);
                        }
                        headBuf = '';
                    }
                }
            }
            if (phase === 1) {
                const s = carry ? carry + text : text;
                const used = scan(s, final);
                carry = phase === 1 ? s.substring(used) : '';
            } else if (phase === 2 && entry === 2 && text) postBuf += text;
            if (final) {
                if (phase === 1) phase = 2;
                if (postBuf) parsePost(postBuf);
                postBuf = '';
                carry = '';
                store.finalize();
                sh.partial = false;
            }
        }

        return { sheet: sh, feed };
    }

    // ---------- workbook ----------
    function resolveTarget(base, target) {
        if (target.indexOf('\\') >= 0) target = target.replace(/\\/g, '/');
        if (target.indexOf('%') >= 0) {
            try {
                target = decodeURIComponent(target);
            } catch (_) {
                /* keep raw */
            }
        }
        if (target.charCodeAt(0) === 47) return target.substring(1);
        const parts = base.split('/');
        parts.pop();
        for (const seg of target.split('/')) {
            if (seg === '..') parts.pop();
            else if (seg !== '.' && seg !== '') parts.push(seg);
        }
        return parts.join('/');
    }
    function relsPathOf(part) {
        const k = part.lastIndexOf('/');
        return part.substring(0, k + 1) + '_rels/' + part.substring(k + 1) + '.rels';
    }
    function parseRels(xml, basePart) {
        const map = {};
        if (!xml) return map;
        eachElem(prep(xml), 'Relationship', a => {
            if (!a.Id || !a.Target) return;
            map[a.Id] = {
                type: a.Type || '',
                target: a.TargetMode === 'External' ? a.Target : resolveTarget(basePart, a.Target),
                external: a.TargetMode === 'External'
            };
        });
        return map;
    }
    function relOfType(rels, suffix) {
        for (const k in rels) if (rels[k].type.endsWith(suffix)) return rels[k].target;
        return null;
    }

    function toU8(b) {
        if (b instanceof Uint8Array) return b;
        if (b && b.buffer instanceof ArrayBuffer && typeof b.byteLength === 'number')
            return new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (Array.isArray(b)) return Uint8Array.from(b);
        return null;
    }

    // table parts: header row range + column names, so edits can be validated
    function loadTables(sh, relsXml, sheetPath, unzip, get) {
        const rels = parseRels(relsXml, sheetPath),
            paths = [];
        for (const k in rels) if (/\/table$/.test(rels[k].type) && !rels[k].external) paths.push(rels[k].target);
        if (!paths.length) return;
        let files;
        try {
            files = unzip(paths);
        } catch (e) {
            if (e && e.code === 'ZIPBOMB') throw e;
            return;
        }
        for (const pth of paths) {
            const x = get(files, pth);
            if (x === null) continue;
            const t = firstElem(prep(x), 'table');
            const rg = t && parseRange(t.a.ref);
            if (!rg) continue;
            const cols = [];
            eachElem(block(t.inner, 'tableColumns'), 'tableColumn', a => {
                cols.push(a.name !== undefined ? decodeStr(a.name) : '');
            });
            const hr = t.a.headerRowCount !== undefined ? parseInt(t.a.headerRowCount, 10) : 1;
            sh.tables.push({ r1: rg.r1, c1: rg.c1, r2: rg.r2, c2: rg.c2, header: hr >= 1, cols });
        }
    }

    // floating pictures (oneCell/twoCell anchors with raster blips) for read-only display; vector charts are skipped
    const B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    function b64(u8) {
        let s = '';
        for (let i = 0; i < u8.length; i += 3) {
            const a = u8[i],
                b = i + 1 < u8.length ? u8[i + 1] : 0,
                c = i + 2 < u8.length ? u8[i + 2] : 0;
            s +=
                B64C[a >> 2] +
                B64C[((a & 3) << 4) | (b >> 4)] +
                (i + 1 < u8.length ? B64C[((b & 15) << 2) | (c >> 6)] : '=') +
                (i + 2 < u8.length ? B64C[c & 63] : '=');
        }
        return s;
    }
    function loadDrawings(sh, relsXml, sheetPath, unzip, get) {
        const pics = [];
        try {
            const rels = parseRels(relsXml, sheetPath);
            let dpath = null;
            for (const k in rels)
                if (!rels[k].external && /\/drawing$/.test(rels[k].type)) {
                    dpath = rels[k].target;
                    break;
                }
            if (!dpath) return;
            let files;
            try {
                files = unzip([dpath, relsPathOf(dpath)], 32 * 1024 * 1024);
            } catch (e) {
                if (e && e.code === 'ZIPBOMB') throw e;
                return;
            }
            const dx = get(files, dpath);
            if (dx === null) return;
            const drels = parseRels(get(files, relsPathOf(dpath)), dpath);
            const anchors = [];
            const clean = prep(dx);
            eachElem(clean, 'oneCellAnchor', (a, inner) => anchors.push(inner));
            eachElem(clean, 'twoCellAnchor', (a, inner) => anchors.push(inner));
            const MIME = {
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                png: 'image/png',
                gif: 'image/gif',
                bmp: 'image/bmp',
                tif: 'image/tiff',
                tiff: 'image/tiff'
            };
            const num = (src, tag, dflt) => {
                const m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(src);
                const v = m && parseInt(m[1], 10);
                return v >= 0 ? v : dflt;
            };
            const metas = [];
            for (const an of anchors) {
                if (metas.length >= 30) break;
                const inner = an.split('<a:').join('<').split('</a:').join('</'); // prep() only strips the root prefix; anchors start with <from>
                const fr = firstElem(inner, 'from');
                if (!fr) continue;
                const col = num(fr.inner, 'col', -1),
                    row = num(fr.inner, 'row', -1);
                if (col < 0 || row < 0 || col > 16383 || row > 1048575) continue;
                let cx = 0,
                    cy = 0;
                eachElem(inner, 'ext', ea => {
                    const x = parseInt(ea.cx, 10) || 0,
                        y = parseInt(ea.cy, 10) || 0;
                    if (!cx && !cy && x > 0 && y > 0 && x <= 95250000 && y <= 95250000) {
                        cx = x;
                        cy = y;
                    }
                });
                if (!cx || !cy) continue;
                let embed = null;
                eachElem(inner, 'blip', ba => {
                    if (!embed) embed = ba['r:embed'] || ba.embed || null;
                });
                if (!embed || !drels[embed] || drels[embed].external) continue;
                const ipath = drels[embed].target;
                const mt = MIME[(ipath.split('.').pop() || '').toLowerCase()];
                if (!mt) continue; // emf/wmf metafiles and native charts cannot render in a webview
                metas.push({
                    r: row,
                    c: col,
                    dx: num(fr.inner, 'colOff', 0) / 9525,
                    dy: num(fr.inner, 'rowOff', 0) / 9525,
                    w: cx / 9525,
                    h: cy / 9525,
                    ipath,
                    mt
                });
            }
            if (!metas.length) return;
            let imgFiles;
            try {
                imgFiles = unzip(
                    metas.map(m => m.ipath),
                    32 * 1024 * 1024
                );
            } catch (e) {
                if (e && e.code === 'ZIPBOMB') throw e;
                return;
            }
            const rawOf = name => {
                if (Object.prototype.hasOwnProperty.call(imgFiles, name)) return imgFiles[name];
                const lc = name.toLowerCase();
                for (const k in imgFiles) if (k.toLowerCase() === lc) return imgFiles[k];
                return null;
            };
            for (const m of metas) {
                const raw = rawOf(m.ipath);
                if (!raw || !raw.length || raw.length > 8 * 1024 * 1024) continue;
                pics.push({
                    r: m.r,
                    c: m.c,
                    dx: m.dx,
                    dy: m.dy,
                    w: m.w,
                    h: m.h,
                    url: 'data:' + m.mt + ';base64,' + b64(raw)
                });
            }
        } catch (e) {
            /* pictures are best-effort display only */
        }
        if (pics.length) sh.pictures = pics;
    }

    // first bytes of selected zip entries via the central directory (partial inflate); stops after maxOut bytes
    function zipHeads(bytes, wanted, fl, maxOut, cb) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let e = bytes.length - 22;
        const lim = Math.max(0, e - 65535);
        for (; e >= lim; e--) if (dv.getUint32(e, true) === 0x06054b50) break;
        if (e < lim) return;
        const total = dv.getUint16(e + 10, true);
        let p = dv.getUint32(e + 16, true);
        const td = new TextDecoder('utf-8');
        for (let k = 0; k < total && p + 46 <= bytes.length; k++) {
            if (dv.getUint32(p, true) !== 0x02014b50) return;
            const method = dv.getUint16(p + 10, true),
                csize = dv.getUint32(p + 20, true);
            const nl = dv.getUint16(p + 28, true),
                el = dv.getUint16(p + 30, true),
                cl = dv.getUint16(p + 32, true),
                lho = dv.getUint32(p + 42, true);
            const name = td
                .decode(bytes.subarray(p + 46, p + 46 + nl))
                .toLowerCase()
                .replace(/\\/g, '/');
            p += 46 + nl + el + cl;
            const target = wanted.get(name);
            if (!target || csize === 0xffffffff || lho === 0xffffffff || lho + 30 > bytes.length) continue;
            const ds = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true),
                de = Math.min(bytes.length, ds + csize);
            let head = '';
            if (method === 0) head = td.decode(bytes.subarray(ds, Math.min(de, ds + maxOut)));
            else if (method === 8) {
                const parts = [];
                let got = 0;
                const inf = new fl.Inflate(c => {
                    if (got < maxOut) {
                        parts.push(c);
                        got += c.length;
                    }
                });
                try {
                    for (let o = ds; o < de && got < maxOut; o += 4096)
                        inf.push(bytes.subarray(o, Math.min(o + 4096, de)), o + 4096 >= de);
                } catch (_) {
                    /* partial is fine */
                }
                const buf = new Uint8Array(got);
                let q = 0;
                for (const c of parts) {
                    buf.set(c, q);
                    q += c.length;
                }
                head = td.decode(buf);
            } else continue;
            cb(target, head);
        }
    }

    function readXlsx(input, opts) {
        const bytes = toU8(input);
        const bad = () => new Error('Not a valid XLSX file');
        if (!bytes || bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw bad();
        const fl = root.fflate;
        const L = Object.assign({}, OX.zipLimits, opts && opts.limits);
        checkZipDir(bytes, L);
        // bounded inflate of one raw-deflate payload; the ratio rule only applies once the output is large
        const capInflate = (data, limit) => {
            const parts = [];
            let got = 0,
                fed = 0;
            const inf = new fl.Inflate(c => {
                got += c.length;
                if (got > limit || (got > L.ratioMin && got > L.ratio * Math.max(1, fed))) throw bombErr();
                parts.push(c);
            });
            for (let o = 0; o < data.length || o === 0; o += 65536) {
                const end = Math.min(data.length, o + 65536);
                fed = end;
                inf.push(data.subarray(o, end), end >= data.length);
                if (end >= data.length) break;
            }
            if (parts.length === 1) return parts[0];
            const out = new Uint8Array(got);
            let q = 0;
            for (const c of parts) {
                out.set(c, q);
                q += c.length;
            }
            return out;
        };
        let dirMap = null,
            dirSkipped = false;
        // central directory: lower-cased entry name -> data range (entries needing the generic unzip are skipped)
        function zipDir() {
            if (dirMap) return dirMap;
            dirMap = new Map();
            try {
                const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let e = bytes.length - 22;
                const lim = Math.max(0, e - 65535);
                for (; e >= lim; e--) if (dv.getUint32(e, true) === 0x06054b50) break;
                if (e < lim) {
                    dirSkipped = true;
                    return dirMap;
                }
                const total = dv.getUint16(e + 10, true);
                let p = dv.getUint32(e + 16, true);
                const td = new TextDecoder('utf-8');
                if (total === 0xffff || p === 0xffffffff) dirSkipped = true;
                for (let k = 0; k < total && p + 46 <= bytes.length; k++) {
                    if (dv.getUint32(p, true) !== 0x02014b50) {
                        dirSkipped = true;
                        break;
                    }
                    const flags = dv.getUint16(p + 8, true),
                        method = dv.getUint16(p + 10, true),
                        csize = dv.getUint32(p + 20, true),
                        usize = dv.getUint32(p + 24, true);
                    const nl = dv.getUint16(p + 28, true),
                        el = dv.getUint16(p + 30, true),
                        cl = dv.getUint16(p + 32, true),
                        lho = dv.getUint32(p + 42, true);
                    const name = td
                        .decode(bytes.subarray(p + 46, p + 46 + nl))
                        .toLowerCase()
                        .replace(/\\/g, '/');
                    p += 46 + nl + el + cl;
                    if (
                        flags & 1 ||
                        csize === 0xffffffff ||
                        usize === 0xffffffff ||
                        lho === 0xffffffff ||
                        lho + 30 > bytes.length ||
                        dv.getUint32(lho, true) !== 0x04034b50 ||
                        (method !== 0 && method !== 8)
                    ) {
                        dirSkipped = true;
                        continue;
                    }
                    const ds = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
                    if (ds + csize > bytes.length) {
                        dirSkipped = true;
                        continue;
                    }
                    dirMap.set(name, { method, ds, de: ds + csize, us: usize });
                }
            } catch (_) {
                dirSkipped = true;
            }
            return dirMap;
        }
        // inflate entries accepted by pred(lowerName); sizes are enforced while inflating, never trusted from headers
        const unzipWhere = (pred, limit) => {
            const out = Object.create(null);
            for (const [name, ent] of zipDir()) {
                if (!pred(name)) continue;
                if (ent.us > limit) throw bombErr();
                const raw = bytes.subarray(ent.ds, ent.de);
                out[name] = ent.method === 0 ? raw : ent.de > ent.ds ? capInflate(raw, limit) : new Uint8Array(0);
            }
            if (dirSkipped) {
                const files = fl.unzipSync(bytes, {
                    filter: f => {
                        const n = f.name.toLowerCase().replace(/\\/g, '/');
                        if (!pred(n) || n in out) return false;
                        if (f.originalSize > limit) throw bombErr();
                        return true;
                    }
                });
                for (const k in files) out[k] = files[k];
            }
            return out;
        };
        const unzip = (names, limit) => {
            const set = new Set(names.map(n => n.toLowerCase().replace(/\\/g, '/')));
            return unzipWhere(n => set.has(n), limit || L.maxPart);
        };
        let first;
        try {
            first = unzipWhere(n => /(^|\/)(_rels\/\.rels|workbook\.xml|workbook\.xml\.rels)$/.test(n), L.maxPart);
        } catch (e) {
            throw e && e.code === 'ZIPBOMB' ? e : bad();
        }
        const get = (files, name) => {
            if (files[name]) return toText(files[name]);
            const lc = name.toLowerCase();
            for (const k in files) if (k.toLowerCase() === lc) return toText(files[k]);
            return null;
        };
        let wbPath = 'xl/workbook.xml';
        const rootRels = get(first, '_rels/.rels');
        if (rootRels) {
            const rr = parseRels(rootRels, '');
            const t = relOfType(rr, '/officeDocument');
            if (t) wbPath = t;
        }
        let wbXml = get(first, wbPath);
        if (wbXml === null) {
            // fall back to any workbook.xml
            for (const k in first)
                if (/workbook\.xml$/i.test(k)) {
                    wbPath = k;
                    wbXml = toText(first[k]);
                    break;
                }
        }
        if (wbXml === null) throw bad();
        wbXml = prep(wbXml);
        const wbRels = parseRels(get(first, relsPathOf(wbPath)), wbPath);

        const sstPath = relOfType(wbRels, '/sharedStrings') || 'xl/sharedStrings.xml';
        const stylesPath = relOfType(wbRels, '/styles') || 'xl/styles.xml';
        const themePath = relOfType(wbRels, '/theme') || 'xl/theme/theme1.xml';
        let meta;
        try {
            meta = unzip([stylesPath, themePath]);
        } catch (e) {
            throw e && e.code === 'ZIPBOMB' ? e : bad();
        }

        const date1904 = (() => {
            const e = firstElem(wbXml, 'workbookPr');
            return !!e && isTrue(e.a.date1904);
        })();

        const theme = parseTheme(get(meta, themePath));
        const indexedCustom = [];
        const stylesXml = get(meta, stylesPath);
        if (stylesXml) {
            const ic = block(prep(stylesXml), 'indexedColors');
            if (ic) {
                let i = 0;
                eachElem(ic, 'rgbColor', a => {
                    indexedCustom[i++] = a.rgb ? '#' + a.rgb.slice(-6).toLowerCase() : null;
                });
            }
        }
        const resolve = makeColorResolver(theme, indexedCustom);
        const ps = parseStyles(stylesXml, resolve);

        let sst = null;
        const sstEnt = zipDir().get(sstPath.toLowerCase().replace(/\\/g, '/'));
        if (
            sstEnt &&
            sstEnt.method === 8 &&
            sstEnt.de > sstEnt.ds &&
            sstEnt.us >= L.lazySst &&
            sstEnt.us <= L.maxPart &&
            typeof TextDecoder !== 'undefined'
        )
            sst = makeLazySst(bytes.subarray(sstEnt.ds, sstEnt.de), L, fl);
        if (!sst) {
            let sstXml;
            try {
                sstXml = get(unzip([sstPath]), sstPath);
            } catch (e) {
                throw e && e.code === 'ZIPBOMB' ? e : bad();
            }
            sst = makeSst(sstXml ? prep(sstXml) : '');
        }

        const sheets = [];
        const sheetRels = [];
        eachElem(block(wbXml, 'sheets'), 'sheet', a => {
            const rid = relId(a);
            const rel = rid !== undefined ? wbRels[rid] : null;
            const i = sheets.length;
            sheets.push({
                index: i,
                name: a.name !== undefined ? a.name : 'Sheet' + (i + 1),
                state: a.state === 'hidden' ? 'hidden' : a.state === 'veryHidden' ? 'veryHidden' : 'visible',
                tabColor: null,
                path: rel
                    ? rel.external
                        ? ''
                        : rel.target
                    : rid === undefined || !Object.keys(wbRels).length
                      ? 'xl/worksheets/sheet' + (i + 1) + '.xml'
                      : ''
            });
            sheetRels.push(rel);
        });

        try {
            const wanted = new Map();
            sheets.forEach(si => {
                if (si.path) wanted.set(si.path.toLowerCase(), si);
            });
            zipHeads(bytes, wanted, fl, 8192, (si, head) => {
                const m = /<(?:[\w.-]+:)?tabColor\b[^>]*>/.exec(head);
                if (m) si.tabColor = resolve(attrMap(m[0])) || si.tabColor;
            });
        } catch (_) {
            /* tab colors fall back to sheet load */
        }

        const ctx = { sst, resolve };
        const cache = new Map();
        const jobs = new Map();

        const abortErr = () => {
            const e = new Error('Loading cancelled');
            e.name = 'AbortError';
            return e;
        };
        const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
        let yields = 0;
        function yieldNow() {
            return new Promise(res => {
                if (++yields % 2 !== 0 && typeof MessageChannel !== 'undefined') {
                    const ch = new MessageChannel();
                    ch.port1.onmessage = () => {
                        ch.port1.close();
                        res();
                    };
                    ch.port2.postMessage(0);
                } else setTimeout(res, 0);
            });
        }

        // prepare a sheet load: { sheet } when nothing to stream, else { sheet (live), step(maxBytes)->done, pos, total, finish() }
        // native: the async job loop may take a stepAsync() source (inflate runs off the main thread)
        function begin(i, native) {
            const info = sheets[i];
            if (!info) throw new Error('No such sheet: ' + i);
            const rel = sheetRels[i];
            if (!info.path || (rel && /\/(chartsheet|dialogsheet)$/.test(rel.type))) return { sheet: emptySheet(info) };
            const rp = relsPathOf(info.path);
            let files;
            try {
                files = unzip([rp]);
            } catch (e) {
                if (e && e.code === 'ZIPBOMB') throw e;
                files = {};
            }
            const relsXml = get(files, rp);
            const ent = zipDir().get(info.path.toLowerCase().replace(/\\/g, '/'));
            const parser = createSheetParser(info, ctx, relsXml);
            const sh = parser.sheet;
            const finish = () => {
                if (relsXml && relsXml.indexOf('/table') >= 0) loadTables(sh, relsXml, info.path, unzip, get);
                if (relsXml && relsXml.indexOf('/drawing') >= 0) loadDrawings(sh, relsXml, info.path, unzip, get);
                return sh;
            };
            if (!ent) {
                // not addressable through the central directory: generic unzip, one chunk
                let x = null;
                try {
                    x = get(unzip([info.path], L.maxSheet), info.path);
                } catch (e) {
                    if (e && e.code === 'ZIPBOMB') throw e;
                    x = null;
                }
                if (x === null) {
                    const es = emptySheet(info);
                    es.warning = 'Worksheet part not found: ' + info.path;
                    return { sheet: es };
                }
                let done = false;
                return {
                    sheet: sh,
                    pos: () => (done ? 1 : 0),
                    total: 1,
                    step() {
                        if (!done) {
                            done = true;
                            parser.feed(x, true);
                        }
                        return true;
                    },
                    finish
                };
            }
            const dec = new TextDecoder('utf-8');
            if (
                native &&
                ent.method === 8 &&
                ent.de - ent.ds >= L.nativeInflate &&
                typeof DecompressionStream === 'function' &&
                typeof Blob === 'function'
            ) {
                const csize = ent.de - ent.ds;
                let reader = null,
                    nGot = 0,
                    fin = false;
                return {
                    sheet: sh,
                    total: csize,
                    // compressed offset is unknown on a native stream: estimate it from the declared output size
                    pos: () =>
                        fin ? csize : ent.us > 0 ? Math.min(csize - 1, Math.floor((csize * nGot) / ent.us)) : 0,
                    async stepAsync() {
                        if (reader === null)
                            reader = new Blob([bytes.subarray(ent.ds, ent.de)])
                                .stream()
                                .pipeThrough(new DecompressionStream('deflate-raw'))
                                .getReader();
                        const r = await reader.read();
                        if (r.done) {
                            fin = true;
                            parser.feed(dec.decode(), true);
                            return true;
                        }
                        nGot += r.value.length;
                        if (nGot > L.maxSheet || (nGot > L.ratioMin && nGot > L.ratio * csize)) throw bombErr();
                        parser.feed(dec.decode(r.value, { stream: true }), false);
                        return false;
                    },
                    cancel() {
                        if (reader !== null) reader.cancel().catch(() => undefined);
                    },
                    finish
                };
            }
            let off = ent.ds;
            let got = 0;
            const inf =
                ent.method === 8 && ent.de > ent.ds
                    ? new fl.Inflate(d => {
                          got += d.length;
                          if (got > L.maxSheet || (got > L.ratioMin && got > L.ratio * Math.max(1, off - ent.ds)))
                              throw bombErr();
                          if (d.length) parser.feed(dec.decode(d, { stream: true }), false);
                      })
                    : null;
            return {
                sheet: sh,
                total: ent.de - ent.ds,
                pos: () => off - ent.ds,
                step(max) {
                    const end = Math.min(ent.de, off + max),
                        last = end >= ent.de;
                    const part = bytes.subarray(off, end);
                    off = end;
                    if (inf !== null) inf.push(part, last);
                    else if (part.length) parser.feed(dec.decode(part, { stream: !last }), false);
                    if (last) parser.feed(dec.decode(), true);
                    return last;
                },
                finish
            };
        }

        function startJob(i) {
            const job = { subs: [], last: null, result: null };
            jobs.set(i, job);
            const emit = info => {
                job.last = info;
                for (const s of job.subs.slice())
                    if (s.onProgress) {
                        try {
                            s.onProgress(info);
                        } catch (_) {
                            /* ui callback errors must not break loading */
                        }
                    }
            };
            (async () => {
                let b = null;
                try {
                    b = begin(i, true);
                    if (!b.step && !b.stepAsync) {
                        cache.set(i, b.sheet);
                        jobs.delete(i);
                        job.result = { sheet: b.sheet };
                        for (const s of job.subs) s.resolve(b.sheet);
                        return;
                    }
                    let t0 = now(),
                        budget = 12;
                    for (;;) {
                        if (b.stepAsync ? await b.stepAsync() : b.step(32768)) break;
                        if (now() - t0 > budget) {
                            emit({
                                sheet: b.sheet,
                                partial: true,
                                rows: b.sheet.rowCount,
                                loaded: b.pos(),
                                total: b.total,
                                fraction: b.total ? b.pos() / b.total : 0
                            });
                            await yieldNow();
                            if (!job.subs.length) {
                                jobs.delete(i);
                                if (b.cancel) b.cancel();
                                return;
                            }
                            t0 = now();
                            budget = 16;
                        }
                    }
                    const sh = b.finish();
                    cache.set(i, sh);
                    jobs.delete(i);
                    job.result = { sheet: sh };
                    const subs = job.subs.slice();
                    job.subs.length = 0;
                    for (const s of subs) {
                        if (s.onProgress) {
                            try {
                                s.onProgress({
                                    sheet: sh,
                                    partial: false,
                                    rows: sh.rowCount,
                                    loaded: b.total,
                                    total: b.total,
                                    fraction: 1
                                });
                            } catch (_) {
                                /* ignore */
                            }
                        }
                        s.resolve(sh);
                    }
                } catch (err) {
                    if (b && b.cancel) b.cancel();
                    jobs.delete(i);
                    job.result = { err };
                    const subs = job.subs.slice();
                    job.subs.length = 0;
                    for (const s of subs) s.reject(err);
                }
            })();
            return job;
        }

        const wb = {
            sheets,
            styles: ps.styles,
            date1904,
            defaultFont: ps.defaultFont,
            loadSheet(i) {
                let sh = cache.get(i);
                if (sh) return sh;
                const b = begin(i);
                if (b.step) {
                    while (!b.step(262144)) {
                        /* sync: run to completion */
                    }
                    sh = b.finish();
                } else sh = b.sheet;
                cache.set(i, sh);
                return sh;
            },
            // Promise<Sheet>; onProgress({sheet, partial, rows, loaded, total, fraction}) runs between time slices while sheet.partial is true
            loadSheetAsync(i, opts) {
                opts = opts || {};
                const hit = cache.get(i);
                if (hit) return Promise.resolve(hit);
                if (!sheets[i]) return Promise.reject(new Error('No such sheet: ' + i));
                if (opts.signal && opts.signal.aborted) return Promise.reject(abortErr());
                const job = jobs.get(i) || startJob(i);
                if (job.result)
                    return job.result.err ? Promise.reject(job.result.err) : Promise.resolve(job.result.sheet);
                return new Promise((resolve, reject) => {
                    const sub = { onProgress: opts.onProgress || null, resolve, reject };
                    job.subs.push(sub);
                    const sig = opts.signal;
                    if (sig && sig.addEventListener) {
                        sig.addEventListener(
                            'abort',
                            () => {
                                const k = job.subs.indexOf(sub);
                                if (k >= 0) {
                                    job.subs.splice(k, 1);
                                    reject(abortErr());
                                }
                            },
                            { once: true }
                        );
                    }
                    if (job.last && sub.onProgress) {
                        try {
                            sub.onProgress(job.last);
                        } catch (_) {
                            /* ignore */
                        }
                    }
                });
            }
        };
        return wb;
    }

    OX.readXlsx = readXlsx;
    OX.createSheetParser = createSheetParser;
    OX.makeSst = makeSst;
    OX.shiftFormula = shiftFormula;
    OX.xmlDecode = xmlDecode;
    OX.decodeOoxmlString = decodeStr;
    if (typeof module !== 'undefined' && module.exports) module.exports = OX;
})(typeof globalThis !== 'undefined' ? globalThis : this);

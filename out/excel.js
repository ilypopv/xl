var sendMessage;
var oxApp = null;

function initPage() {
    const vscode = acquireVsCodeApi();
    const options = getOptions();
    const STATE_VERSION = '6';
    const readOnly = !options.customEditor;
    sendMessage = function (m) {
        vscode.postMessage(m);
    };

    const app = document.getElementById('app');
    let wb = null,
        bytes = null,
        active = 0;
    let calc = null;
    const providers = new Map();
    const views = {};
    let undoStack = [],
        redoStack = [],
        undoCells = 0;
    let shell = null,
        loadCtl = null,
        cancelBtn = null;

    const saved = (function () {
        if (ignoreState()) return null;
        const s = vscode.getState() || options.state;
        return s && s.version === STATE_VERSION ? s : null;
    })();

    function measure(text, style) {
        const c = measure.ctx || (measure.ctx = document.createElement('canvas').getContext('2d'));
        c.font =
            (style && style.b ? 'bold ' : '') +
            (style && style.size ? (style.size * 4) / 3 : 13) +
            'px ' +
            ((style && style.font) || 'system-ui');
        return c.measureText(text).width;
    }

    function createShell() {
        shell = new OX.Shell(app, {
            readOnly: readOnly,
            tabs: true,
            headerRows: function () {
                return shell && shell.provider ? shell.provider.frozenRows || 1 : 0;
            },
            onEdit: applyEdits,
            onViewState: function (vs) {
                views[active] = vs;
                const state = { version: STATE_VERSION, uri: options.uri, sheet: active, views: views };
                vscode.setState(state);
                vscode.postMessage({ save: true, state: state });
            },
            onLink: onLink
        });
        oxApp = shell;
        const picLayer = document.createElement('div');
        picLayer.className = 'ox-pics';
        shell.grid.el.appendChild(picLayer);
        // floating sheet pictures (drawing anchors): read-only overlay positioned over the canvas
        shell._pics = null;
        shell.layoutPics = function () {
            const g = shell.grid,
                p = shell.provider;
            const pics = (p && p.sheet && p.sheet.pictures) || [];
            while (picLayer.children.length > pics.length) picLayer.removeChild(picLayer.lastChild);
            if (!pics.length) return;
            const W = g.el.clientWidth,
                H = g.el.clientHeight,
                z = g.getZoom();
            for (let i = 0; i < pics.length; i++) {
                const q = pics[i];
                let img = picLayer.children[i];
                if (!img || img.tagName !== 'IMG') {
                    img = document.createElement('img');
                    if (picLayer.children[i]) picLayer.replaceChild(img, picLayer.children[i]);
                    else picLayer.appendChild(img);
                }
                if (img.getAttribute('src') !== q.url) img.setAttribute('src', q.url);
                img.alt = '';
                const rc = g.cellRect(q.r, q.c);
                const L = Math.round(rc.x + q.dx * z),
                    T = Math.round(rc.y + q.dy * z),
                    Wd = Math.max(1, Math.round(q.w * z)),
                    Ht = Math.max(1, Math.round(q.h * z));
                img.style.cssText = 'left:' + L + 'px;top:' + T + 'px;width:' + Wd + 'px;height:' + Ht + 'px;';
                img.style.display = L + Wd < 0 || T + Ht < 0 || L > W || T > H ? 'none' : '';
            }
        };
        shell.grid.scroller.addEventListener(
            'scroll',
            function () {
                shell.layoutPics();
            },
            { passive: true }
        );
        shell.grid.on('zoom', function () {
            shell.layoutPics();
        });
        shell.grid.on('resizeCol', function () {
            shell.layoutPics();
        });
        shell.grid.on('resizeRow', function () {
            shell.layoutPics();
        });
        document.addEventListener('keydown', function (e) {
            if (
                (e.ctrlKey || e.metaKey) &&
                !e.shiftKey &&
                !e.altKey &&
                wb &&
                (e.key === 'PageDown' || e.key === 'PageUp')
            ) {
                const vis = visibleSheets();
                const i = vis.indexOf(active);
                const n = vis[(i + (e.key === 'PageDown' ? 1 : vis.length - 1)) % vis.length];
                if (n !== undefined && n !== active) {
                    e.preventDefault();
                    showSheet(n);
                }
            }
        });
    }

    function onLink(e) {
        if (!e || !wb) return;
        const p = shell.provider;
        const link = (p && p.sheet && p.sheet.hyperlinks && p.sheet.hyperlinks.get(e.sr + ',' + e.c)) || {};
        const url = e.url || link.url,
            loc = e.location || link.location;
        if (url) sendMessage({ openLink: url });
        else if (loc) goLocation(loc);
    }

    function goLocation(loc) {
        const m = /^(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/.exec(String(loc).trim());
        let ref = String(loc).trim(),
            idx = active;
        if (m) {
            const name = (m[1] ? m[1].replace(/''/g, "'") : m[2]).toLowerCase();
            const sh = wb.sheets.filter(function (s) {
                return s.name.toLowerCase() === name && s.state === 'visible';
            })[0];
            if (!sh) {
                shell.setMessage('Link target sheet not found: ' + (m[1] || m[2]));
                return;
            }
            idx = sh.index;
            ref = m[3];
        }
        if (idx !== active) showSheet(idx);
        if (!shell._goto(ref)) shell.setMessage('Cannot follow link: ' + loc);
    }

    function visibleSheets() {
        const out = [];
        wb.sheets.forEach(function (s) {
            if (s.state === 'visible') out.push(s.index);
        });
        return out.length ? out : [0];
    }

    function renderTabs() {
        shell.tabs.textContent = '';
        visibleSheets().forEach(function (i) {
            const info = wb.sheets[i];
            const b = document.createElement('button');
            b.className = 'ox-tab' + (i === active ? ' active' : '');
            b.textContent = info.name;
            if (info.tabColor) b.style.boxShadow = 'inset 0 -3px 0 ' + info.tabColor;
            b.addEventListener('click', function () {
                if (i !== active) showSheet(i);
            });
            shell.tabs.appendChild(b);
        });
    }

    function newProvider(sheet) {
        return new OX.XlsxProvider(wb, sheet, { measure: measure });
    }

    function loadError(i, err) {
        const msg =
            'Cannot load sheet "' +
            (wb.sheets[i] ? wb.sheets[i].name : i) +
            '": ' +
            (err && err.message ? err.message : err);
        shell.setMessage(msg);
        sendMessage({ error: 'xl: ' + msg });
    }

    function setCancel(fn) {
        if (!cancelBtn) {
            cancelBtn = document.createElement('button');
            cancelBtn.className = 'ox-tab';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'margin-left:8px;cursor:pointer';
            shell.status.insertBefore(cancelBtn, shell.msg.nextSibling);
        }
        cancelBtn.onclick = fn;
        cancelBtn.style.display = fn ? '' : 'none';
    }

    function mount(p, i, viewState, loading) {
        shell.setProvider(p);
        if (!loading) shell.setMessage('Ready');
        shell.applyViewState(viewState || views[i] || null);
        shell.layoutPics();
        shell.grid.focus();
    }

    // streams the sheet in; the first rows are shown as soon as they are parsed, the rest keeps loading in time slices
    function showSheet(i, viewState) {
        if (loadCtl) {
            loadCtl.abort();
            loadCtl = null;
            setCancel(null);
        }
        const prev = active;
        active = i;
        renderTabs();
        const done = providers.get(i);
        if (done) {
            mount(done, i, viewState);
            return;
        }
        const ctl = new AbortController(),
            name = wb.sheets[i].name;
        let p = null,
            lastInv = 0;
        loadCtl = ctl;
        shell.setMessage('Loading ' + name + '... 0%');
        setCancel(function () {
            ctl.abort();
            if (p) {
                p.cancelledPartial = true;
                shell.setMessage(
                    'Loading cancelled: showing the first ' + p.sheet.rowCount.toLocaleString() + ' rows (read only)'
                );
                loadCtl = null;
                setCancel(null);
            } else if (prev !== i && providers.has(prev)) {
                loadCtl = null;
                setCancel(null);
                showSheet(prev);
                shell.setMessage('Loading cancelled');
            } else {
                loadCtl = null;
                setCancel(null);
                shell.setMessage('Loading cancelled');
            }
        });
        wb.loadSheetAsync(i, {
            signal: ctl.signal,
            onProgress: function (info) {
                if (ctl.signal.aborted || loadCtl !== ctl) return;
                if (info.partial)
                    shell.setMessage(
                        'Loading ' +
                            name +
                            '... ' +
                            Math.floor(info.fraction * 100) +
                            '%  (' +
                            info.rows.toLocaleString() +
                            ' rows)'
                    );
                else return;
                if (!p && info.rows > 0) {
                    p = newProvider(info.sheet);
                    mount(p, i, viewState, true);
                    lastInv = Date.now();
                } else if (p && Date.now() - lastInv > 500) {
                    shell.grid.invalidate();
                    lastInv = Date.now();
                }
            }
        })
            .then(function (sh) {
                if (loadCtl !== ctl) return;
                loadCtl = null;
                setCancel(null);
                if (!p) p = newProvider(sh);
                providers.set(i, p);
                if (!readOnly) setTimeout(() => ensureEdit().catch(() => undefined), 0);
                if (shell.provider === p) {
                    shell.grid.invalidate();
                    shell.layoutPics();
                    if (shell.view && (shell.view.sort || shell.view.filters.size)) shell.recomputeView();
                    shell._updateAll();
                    shell.setMessage(sh.warning ? sh.warning : 'Ready');
                } else mount(p, i, viewState);
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') return;
                if (loadCtl === ctl) {
                    loadCtl = null;
                    setCancel(null);
                }
                loadError(i, err);
            });
    }

    function load(content) {
        const raw = content && content.data !== undefined ? content.data : content;
        const reloading = !!wb;
        // parse first: a file that fails to open must not wipe the workbook (and unsaved edits) on screen
        let nb, nbytes;
        try {
            nbytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            nb = OX.readXlsx(nbytes);
        } catch (err) {
            const why = err && err.message ? err.message : String(err);
            shell.setMessage(
                (reloading ? 'Cannot reload file (keeping the previous content): ' : 'Cannot open file: ') + why
            );
            sendMessage({ error: 'xl: ' + why });
            return;
        }
        console.log(
            '[xl] workbook parsed ' +
                Math.round(performance.now() - window.oxExcel.t0) +
                ' ms after start, ' +
                nbytes.length +
                ' bytes'
        );
        bytes = nbytes;
        wb = nb;
        if (loadCtl) {
            loadCtl.abort();
            loadCtl = null;
            setCancel(null);
        }
        providers.clear();
        calc = null;
        undoStack = [];
        redoStack = [];
        undoCells = 0;
        let idx = 0;
        const vis = visibleSheets();
        if (saved && saved.views)
            Object.keys(saved.views).forEach(function (k) {
                if (!views[k]) views[k] = saved.views[k];
            });
        // On a host refresh keep the sheet the user is on; the saved state only decides the first load.
        if (reloading && vis.indexOf(active) >= 0) idx = active;
        else if (saved && saved.sheet !== undefined && vis.indexOf(saved.sheet) >= 0) idx = saved.sheet;
        else idx = vis[0];
        try {
            showSheet(idx);
        } catch (err) {
            loadError(idx, err);
        }
    }

    function providerFor(si) {
        let q = providers.get(si);
        if (!q) {
            q = newProvider(wb.loadSheet(si));
            providers.set(si, q);
        }
        return q;
    }

    function getCalc() {
        if (calc) return calc;
        calc = new OX.Calc({
            sheetNames: wb.sheets.map(function (x) {
                return x.name;
            }),
            date1904: wb.date1904,
            sheetIndexByName: function (n) {
                const l = String(n).toLowerCase();
                for (let i = 0; i < wb.sheets.length; i++) if (wb.sheets[i].name.toLowerCase() === l) return i;
                return -1;
            },
            getCell: function (si, r, c) {
                return providerFor(si).cellAt(r, c);
            },
            getExtent: function (si) {
                const q = providerFor(si);
                return { rowCount: q.rowCount, colCount: q.colCount };
            },
            forEachCell: function (si, r1, c1, r2, c2, cb) {
                providerFor(si).forEachCell(r1, c1, r2, c2, function (cell, r, c) {
                    cb(r, c, cell);
                });
            }
        });
        return calc;
    }

    function inArrayFormula(q, r, c) {
        const arr = q.sheet && q.sheet.arrays;
        if (!arr) return false;
        for (let i = 0; i < arr.length; i++) {
            const a = arr[i];
            if (r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2) return true;
        }
        return false;
    }

    // writes a calculated value into the cell, keeping its formula and style; recorded in the undo transaction
    function putCalculated(q, si, r, c, res, items, seen) {
        const cell = q.cellAt(r, c);
        if (!cell || !cell.f || inArrayFormula(q, r, c)) return false;
        let t = res.t,
            v = res.v;
        if (t === 'e' && v === '#CIRC!') {
            t = 'n';
            v = 0;
        }
        if (cell.t === t && cell.v === v) return false;
        const key = si + ':' + r + ':' + c;
        let it = seen.get(key);
        const before = q.setCell(r, c, { t: t, v: v, f: cell.f, s: cell.s });
        const after = q.overlay.has(r * 16384 + c) ? q.overlay.get(r * 16384 + c) : undefined;
        if (it) it.after = after;
        else {
            it = { si: si, r: r, c: c, before: before, after: after };
            seen.set(key, it);
            items.push(it);
        }
        return true;
    }

    // result cells inside array formulas are not recomputed (the engine cannot spill); these are reported to the user
    let staleArrays = 0;
    function noteArray(q, r, c) {
        if (inArrayFormula(q, r, c)) staleArrays++;
    }

    function recalculate(q, si, items) {
        if (!OX.Calc) return 0;
        let n = 0;
        staleArrays = 0;
        try {
            const engine = getCalc();
            const seen = new Map();
            items.forEach(function (it) {
                seen.set(si + ':' + it.r + ':' + it.c, it);
            });
            items.slice().forEach(function (it) {
                const cell = q.cellAt(it.r, it.c);
                if (cell && cell.f) {
                    const res = engine.evaluate(si, it.r, it.c, cell.f);
                    if (putCalculated(q, si, it.r, it.c, res, items, seen)) n++;
                }
            });
            let changed = items.map(function (it) {
                return { sheet: it.si !== undefined ? it.si : si, r: it.r, c: it.c };
            });
            for (let round = 0; round < 40 && changed.length; round++) {
                const res = engine.recalcDependents(changed, { maxEvals: 500000, timeBudgetMs: 250, volatile: false });
                res.forEach(function (val) {
                    const vq = providerFor(val.sheet);
                    noteArray(vq, val.r, val.c);
                    if (putCalculated(vq, val.sheet, val.r, val.c, val, items, seen)) n++;
                });
                changed = res.partial && res.pending ? res.pending : [];
            }
        } catch (err) {
            shell.setMessage('Formulas were not recalculated: ' + (err && err.message ? err.message : err));
            calc = null;
            return -1;
        }
        return n;
    }

    // the formula engine and the writer are a separate script, fetched once editing is possible
    let editReady = null;
    function hasEditModule() {
        return !!(OX.Calc && OX.patchXlsx);
    }
    function ensureEdit() {
        if (hasEditModule()) return Promise.resolve();
        if (!editReady)
            editReady = new Promise(function (resolve, reject) {
                const s = document.createElement('script');
                s.src = options.editScript;
                s.onload = function () {
                    resolve();
                };
                s.onerror = function () {
                    editReady = null;
                    reject(new Error('Cannot load the editing module'));
                };
                document.head.appendChild(s);
            });
        return editReady;
    }

    function applyEdits(edits, source) {
        if (readOnly || !wb) return;
        if (!hasEditModule()) {
            shell.setMessage('Loading editor...');
            ensureEdit().then(
                function () {
                    applyEdits(edits, source);
                },
                function (err) {
                    shell.setMessage('Edit failed: ' + (err && err.message ? err.message : err));
                    shell.grid.refresh();
                }
            );
            return;
        }
        const p = shell.provider,
            si = active,
            items = [];
        if (p.sheet && p.sheet.partial) {
            shell.setMessage(
                p.cancelledPartial
                    ? 'Loading was cancelled: this sheet is read only. Switch sheets and back to load it again.'
                    : 'The sheet is still loading: wait for it to finish before editing.'
            );
            shell.grid.refresh();
            return;
        }
        let firstError = null,
            rejected = 0;
        for (const e of edits) {
            if (p.getRaw(e.r, e.c) === e.text) continue;
            let cell = p.editFromText(e.r, e.c, e.text);
            if (cell === undefined) continue;
            if (cell && cell.error) {
                rejected++;
                if (!firstError) firstError = cell.error;
                continue;
            }
            if (cell.cleared) cell = null;
            const before = p.setCell(e.r, e.c, cell);
            items.push({
                r: e.r,
                c: e.c,
                before: before,
                after: p.overlay.has(e.r * 16384 + e.c) ? p.overlay.get(e.r * 16384 + e.c) : undefined
            });
        }
        if (firstError)
            shell.setMessage('Edit rejected: ' + firstError + (rejected > 1 ? ' (' + rejected + ' cells)' : ''));
        if (!items.length) {
            shell.grid.refresh();
            return;
        }
        const recalced = recalculate(p, si, items);
        undoStack.push({ si: si, items: items });
        undoCells += items.length;
        while (undoStack.length > 1 && (undoStack.length > 2000 || undoCells > 500000))
            undoCells -= undoStack.shift().items.length;
        redoStack = [];
        shell.grid.invalidate();
        shell.grid.refresh();
        shell._updateAll();
        if (!firstError && staleArrays > 0)
            shell.setMessage(
                'Array formula results are not recalculated here and may be out of date; they update when the file is opened in Excel.'
            );
        else if (!firstError && recalced > 0)
            shell.setMessage('Recalculated ' + recalced.toLocaleString() + ' formula' + (recalced === 1 ? '' : 's'));
        sendMessage({ changed: true, reason: source === 'paste' ? 'Paste' : 'Edit' });
    }

    function undo() {
        const tx = undoStack.pop();
        if (!tx) return;
        undoCells -= tx.items.length;
        if (tx.si !== active) showSheet(tx.si);
        for (let i = tx.items.length - 1; i >= 0; i--) {
            const it = tx.items[i];
            providerFor(it.si !== undefined ? it.si : tx.si).restoreSlot(it.r, it.c, it.before);
        }
        calc = null;
        redoStack.push(tx);
        shell.grid.refresh();
        shell._updateAll();
    }

    function redo() {
        const tx = redoStack.pop();
        if (!tx) return;
        if (tx.si !== active) showSheet(tx.si);
        for (const it of tx.items) providerFor(it.si !== undefined ? it.si : tx.si).restoreSlot(it.r, it.c, it.after);
        calc = null;
        undoStack.push(tx);
        undoCells += tx.items.length;
        shell.grid.refresh();
        shell._updateAll();
    }

    function getBytes() {
        const edits = [];
        providers.forEach(function (p, si) {
            if (p.dirty) Array.prototype.push.apply(edits, p.pendingEdits(si));
        });
        if (!edits.length) return bytes;
        try {
            return OX.patchXlsx(bytes, edits);
        } catch (err) {
            const msg = 'Could not save your edits: ' + (err && err.message ? err.message : err);
            shell.setMessage(msg);
            throw new Error(msg);
        }
    }

    function getBytesAsync() {
        let dirty = false;
        providers.forEach(function (p) {
            if (p.dirty) dirty = true;
        });
        return (dirty ? ensureEdit() : Promise.resolve()).then(getBytes);
    }

    window.oxExcel = {
        load: load,
        undo: undo,
        redo: redo,
        getBytes: getBytes,
        getBytesAsync: getBytesAsync
    };

    createShell();
    shell.setMessage('Opening...');
    const t0 = performance.now();
    window.oxExcel.t0 = t0;
    if (options.directUrl) {
        // read the file straight from disk; any failure falls back to the host round trip
        fetch(options.directUrl, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .then(
                function (buf) {
                    return new Uint8Array(buf);
                },
                function () {
                    return null;
                }
            )
            .then(function (u8) {
                if (u8) {
                    console.log('[xl] file fetched in ' + Math.round(performance.now() - t0) + ' ms');
                    load(u8);
                } else vscode.postMessage({ refresh: true });
            });
    } else vscode.postMessage({ refresh: true });
}

function handleEvents() {
    window.addEventListener('message', function (event) {
        const d = event.data,
            app = window.oxExcel;
        if (!app) return;
        if (d.refresh) app.load(d.content);
        else if (d.type === 'getData') {
            app.getBytesAsync().then(
                function (body) {
                    sendMessage({ response: true, requestId: d.requestId, body: body });
                },
                function (err) {
                    sendMessage({
                        response: true,
                        requestId: d.requestId,
                        error: (err && err.message) || String(err)
                    });
                }
            );
        } else if (d.undo) app.undo();
        else if (d.redo) app.redo();
        else if (d.content && !d.type) app.load(d.content);
    });
}

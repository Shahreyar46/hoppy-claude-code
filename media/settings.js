// Hoppy settings page. Talks to the extension through postMessage only.
// API keys typed here go straight to the extension; this page only ever receives the last 4 characters.
(function () {
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const saved = vscode.getState() || {};
    let tab = saved.tab || 'accounts';
    let state = null;
    let toast = null;
    let animate = true;
    const keyResults = {};

    // Edits that are not saved yet
    let draftEnabled = null;
    let draftMain = null;
    let draftSmall = null;
    let draftFallback = null;
    let search = '';
    let freeOnly = true;
    let enabledOnly = false;

    const TABS = [
        ['accounts', 'Accounts'],
        ['providers', 'AI Providers'],
        ['models', 'Models'],
        ['fallback', 'Backups'],
    ];
    const MONO = { openrouter: 'OR', gemini: 'G', deepseek: 'DS', glm: 'Z' };
    const svg = (d, size = 16) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    const ICON = {
        check: svg('<path d="M20 6 9 17l-5-5"/>'),
        x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
        up: svg('<path d="m18 15-6-6-6 6"/>'),
        down: svg('<path d="m6 9 6 6 6-6"/>'),
        plus: svg('<path d="M12 5v14M5 12h14"/>'),
        refresh: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
        external: svg('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', 14),
        swap: svg('<path d="M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4"/>', 20),
        play: svg('<path d="m7 4 13 8-13 8z" fill="currentColor"/>', 14),
        plug: svg('<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>', 32),
        layers: svg('<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>', 32),
        book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>', 14),
    };
    // Actions that change config; ignored while a save is running so saves cannot collide.
    const MUTATING = new Set(['save-key', 'save-models', 'save-fallback', 'toggle', 'switch', 'add-account', 'setup']);
    let busy = false;

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtCtx = (n) => (!n ? '—' : n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}K`);
    const fmtPrice = (m) => (m.free ? 'free' : m.priceIn == null ? 'paid' : `$${m.priceIn.toFixed(2)} / $${m.priceOut.toFixed(2)}`);
    const model = (sel) => state.catalog.find((c) => c.selector === sel);
    const modelName = (sel) => model(sel)?.name || sel;
    const initials = (s) => (String(s).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
    const chip = (text, kind = '', title = '') => `<span class="chip ${kind}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
    const dirty = () =>
        state &&
        (draftMain !== state.mainModel ||
            draftSmall !== state.smallModel ||
            JSON.stringify(draftFallback) !== JSON.stringify(state.fallback) ||
            JSON.stringify([...draftEnabled].sort()) !== JSON.stringify(enabledFromState().sort()));

    function enabledFromState() {
        return state.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m}`));
    }

    function setTab(t, focus) {
        if (!TABS.some(([id]) => id === t)) {
            return;
        }
        tab = t;
        animate = true;
        vscode.setState({ tab });
        render();
        if (focus) {
            document.getElementById(`tab-${t}`)?.focus();
        }
    }

    function resetDrafts() {
        draftEnabled = new Set(enabledFromState());
        draftMain = state.mainModel;
        draftSmall = state.smallModel;
        draftFallback = [...state.fallback];
    }

    // ---------- Header ----------

    function routeStrip() {
        const nodes = state.targets
            .map(
                (t) => `
            <button class="hop ${t.current ? 'current' : ''} ${t.kind}" ${t.current ? 'aria-current="true" disabled' : ''}
                data-act="switch" data-dir="${esc(t.dir)}" title="${t.current ? 'In use now' : `Switch to ${esc(t.title)}`}">
                <span class="dot" aria-hidden="true"></span>
                <span class="hop-label">${t.kind === 'other' ? 'Other AI' : esc(t.label)}</span>
            </button>`,
            )
            .join('<span class="wire" aria-hidden="true"></span>');
        return `<div class="route" role="group" aria-label="Where the Claude panel points">${nodes}</div>`;
    }

    function onboarding() {
        if (!state.ccrReady) {
            return `
            <section class="callout">
                <div><strong>Other AI models are not set up yet.</strong>
                <div class="muted">Hoppy installs the local router and walks you through adding a free key.</div></div>
                <button data-act="setup">Set up now</button>
            </section>`;
        }
        if (!state.providers.some((p) => p.enabled)) {
            return `
            <section class="callout">
                <div><strong>Connect other AI models in about 2 minutes.</strong>
                <div class="muted">Add any API key, free or paid. A free OpenRouter key alone unlocks 15+ free models.</div></div>
                <button data-act="goto" data-tab="providers">Add an API key</button>
            </section>`;
        }
        return '';
    }

    // ---------- Tabs ----------

    function accountsTab() {
        const claude = state.targets.filter((t) => t.kind === 'claude');
        const other = state.targets.find((t) => t.kind === 'other');
        const card = (t) => `
            <article class="card account ${t.current ? 'is-current' : ''}">
                <div class="avatar ${t.kind}" aria-hidden="true">${t.kind === 'other' ? ICON.swap : esc(initials(t.label))}</div>
                <div class="grow">
                    <h3>${esc(t.kind === 'other' ? 'Other AI models' : t.label)}
                        ${t.current ? chip('in use', 'accent') : ''}
                        ${t.kind === 'claude' ? (t.loggedIn ? chip('logged in', 'ok') : chip('needs login', 'warn')) : ''}
                    </h3>
                    <div class="muted">${t.kind === 'other' ? `Models from your API keys (OpenRouter, Gemini, DeepSeek, GLM…) · ${state.gateway ? 'ready' : 'stopped'}` : esc(t.email || 'Email appears after the first login')}</div>
                    <code class="path">${esc(t.dir)}</code>
                </div>
                <div class="actions">
                    ${t.kind === 'claude' ? `<button class="ghost" data-act="rename" data-dir="${esc(t.dir)}">Rename</button>` : ''}
                    ${t.current ? '' : `<button data-act="switch" data-dir="${esc(t.dir)}">Switch</button>`}
                </div>
            </article>`;
        return `
            <p class="lead">Each Claude account keeps its own login. When you switch, this project's chats come along, so <code>/resume</code> shows all of them.</p>
            <h2 class="section">Claude accounts <span class="count">${claude.length}</span></h2>
            ${claude.map(card).join('')}
            <button class="add" data-act="add-account">${ICON.plus} Add Claude account</button>
            <h2 class="section">Other AI</h2>
            ${other ? card(other) : ''}
            <p class="fineprint">Use accounts you own, for example Work and Personal. Several accounts used only to get around usage limits can break Anthropic's terms.</p>`;
    }

    function providersTab() {
        if (!state.ccrReady) {
            return emptyState(ICON.plug, 'One-time setup needed', 'Hoppy installs a small local helper that connects Claude Code to other AI models. It takes about a minute and needs no terminal.', '<button data-act="setup">Install and set up</button>');
        }
        return `
            <p class="lead">Turn providers on, paste a key, and Hoppy checks it before saving. Keys stay on this PC; this page only sees the last 4 characters.</p>
            <div class="grid">${state.providers
                .map((p) => {
                    const result = keyResults[p.id];
                    const statusLine = p.enabled
                        ? `<span class="mono">••••${esc(p.keyHint || '')}</span> · ${p.models.length} model${p.models.length === 1 ? '' : 's'}`
                        : p.savedKey
                          ? 'Off · key kept, switch on to use it'
                          : 'No key yet';
                    return `
                <article class="card provider ${p.enabled ? 'is-on' : ''} p-${p.id}" id="prov-${p.id}">
                    <header>
                        <div class="mono-tile" aria-hidden="true">${MONO[p.id] || esc(initials(p.label))}</div>
                        <div class="grow">
                            <h3>${esc(p.label)}</h3>
                            <div class="muted small">${esc(p.note)}</div>
                        </div>
                        <label class="toggle" title="${p.enabled ? 'Turn off (the key is kept)' : 'Turn on'}">
                            <input type="checkbox" role="switch" aria-checked="${p.enabled}" aria-label="${esc(p.label)} on or off" data-act="toggle" data-provider="${p.id}" ${p.enabled ? 'checked' : ''}>
                            <span class="track" aria-hidden="true"><span class="thumb"></span></span>
                        </label>
                    </header>
                    <div class="status-line small">${statusLine}</div>
                    <div class="keyrow">
                        <label class="sr-only" for="key-${p.id}">${esc(p.label)} API key</label>
                        <input type="password" id="key-${p.id}" placeholder="${p.enabled ? 'Paste a new key to replace' : 'Paste API key'}" autocomplete="off" spellcheck="false">
                        <button data-act="save-key" data-provider="${p.id}">Test &amp; save</button>
                    </div>
                    <div class="row between">
                        ${result ? `<div class="result ${result.ok ? 'ok' : 'err'}" role="status">${result.ok ? ICON.check : ICON.x} ${esc(result.message)}</div>` : '<span></span>'}
                        <button class="link" data-act="url" data-url="${esc(p.keyUrl)}">Get a key ${ICON.external}</button>
                    </div>
                </article>`;
                })
                .join('')}</div>`;
    }

    function modelsTab() {
        if (!state.catalog.length) {
            return emptyState(ICON.layers, 'No models yet', 'Turn on at least one provider to choose models.', '<button data-act="goto" data-tab="providers">Open AI Providers</button>');
        }
        const q = search.toLowerCase();
        const list = state.catalog
            .filter((m) => !q || m.name.toLowerCase().includes(q) || m.selector.toLowerCase().includes(q))
            .filter((m) => !freeOnly || m.free || draftEnabled.has(m.selector))
            .filter((m) => !enabledOnly || draftEnabled.has(m.selector))
            .sort((a, b) => Number(draftEnabled.has(b.selector)) - Number(draftEnabled.has(a.selector)) || a.name.localeCompare(b.name));
        const enabled = state.catalog.filter((m) => draftEnabled.has(m.selector));
        const options = (sel) => enabled.map((m) => `<option value="${esc(m.selector)}" ${m.selector === sel ? 'selected' : ''}>${esc(m.name)}${m.vision ? ' · reads images' : ''}</option>`).join('');
        const rows = list
            .slice(0, 300)
            .map((m) => {
                const on = draftEnabled.has(m.selector);
                return `
                <label class="model-row ${on ? 'on' : ''}">
                    <input type="checkbox" data-act="model" data-sel="${esc(m.selector)}" ${on ? 'checked' : ''}>
                    <span class="grow">
                        <span class="model-name">${esc(m.name)}</span>
                        <code class="path">${esc(m.selector)}</code>
                    </span>
                    <span class="model-meta">
                        ${m.vision ? chip('reads images', 'info', 'Can read screenshots in your chats') : ''}
                        ${chip(fmtCtx(m.ctx), '', 'Context window')}
                        ${chip(fmtPrice(m), m.free ? 'ok' : '', m.free ? 'No cost' : 'Price per 1M tokens, input / output')}
                    </span>
                </label>`;
            })
            .join('');
        return `
            ${state.catalogError ? `<div class="callout warn small">${esc(state.catalogError)}</div>` : ''}
            <section class="card defaults">
                <div class="field">
                    <label for="main">Main model</label>
                    <div class="hint">Does the real work (Opus, Sonnet and Fable slots)</div>
                    <select id="main">${options(draftMain)}</select>
                </div>
                <div class="field">
                    <label for="small">Helper model</label>
                    <div class="hint">Small background jobs: chat titles, summaries, safety checks. A fast model is best.</div>
                    <select id="small">${options(draftSmall)}</select>
                </div>
            </section>
            <div class="toolbar">
                <input type="search" id="search" placeholder="Search ${state.catalog.length} models…" value="${esc(search)}" aria-label="Search models">
                <label class="check"><input type="checkbox" id="free-only" ${freeOnly ? 'checked' : ''}> Free only</label>
                <label class="check"><input type="checkbox" id="enabled-only" ${enabledOnly ? 'checked' : ''}> Enabled only</label>
                <button class="ghost icon" data-act="refresh-catalog" title="Reload the model catalog" aria-label="Reload the model catalog">${ICON.refresh}</button>
            </div>
            <p class="fineprint"><strong>${enabled.length}</strong> enabled · showing ${Math.min(list.length, 300)} of ${list.length}. Only models that can use tools are listed, because Claude Code needs them. Prices per 1M tokens, input / output.</p>
            <div class="model-list" role="group" aria-label="Models">${rows || '<p class="muted pad">No models match.</p>'}</div>
            ${saveBar('save-models', 'Save models')}`;
    }

    function fallbackTab() {
        const enabledSel = new Set(draftEnabled);
        const visionInChain = draftFallback.some((s) => model(s)?.vision && enabledSel.has(s));
        const addable = state.catalog.filter((m) => enabledSel.has(m.selector) && !draftFallback.includes(m.selector));
        const hops = draftFallback
            .map((s, i) => {
                const m = model(s);
                const skipped = !enabledSel.has(s);
                return `
                <li class="hopcard ${skipped ? 'skipped' : ''}">
                    <span class="node" aria-hidden="true">${i + 1}</span>
                    <div class="grow">
                        <div class="model-name">${esc(modelName(s))} ${m?.vision ? chip('reads images', 'info') : ''} ${skipped ? chip('turned off · skipped', 'warn') : ''}</div>
                        <code class="path">${esc(s)}</code>
                    </div>
                    <div class="actions">
                        <button class="ghost icon" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${ICON.up}</button>
                        <button class="ghost icon" data-act="down" data-i="${i}" ${i === draftFallback.length - 1 ? 'disabled' : ''} aria-label="Move down">${ICON.down}</button>
                        <button class="ghost icon" data-act="remove" data-i="${i}" aria-label="Remove">${ICON.x}</button>
                    </div>
                </li>`;
            })
            .join('');
        return `
            <p class="lead">Backup models are used automatically when the model you picked is busy, out of free requests, or can't read a screenshot. They are tried from top to bottom.</p>
            ${visionInChain ? '' : '<div class="callout warn small" role="alert">None of these backups can read screenshots, so chats with images will fail. Add one marked <strong>reads images</strong>.</div>'}
            <ol class="chain">
                <li class="hopcard start"><span class="node" aria-hidden="true">${ICON.play}</span><div class="grow"><div class="model-name">The model you picked</div><div class="muted small">Tried first</div></div></li>
                ${hops || '<li class="hopcard empty"><span class="node" aria-hidden="true">·</span><div class="muted">No backups: when the model fails, you see the error.</div></li>'}
            </ol>
            <div class="toolbar">
                <select id="add-fallback" aria-label="Model to add" ${addable.length ? '' : 'disabled'}>${addable.map((m) => `<option value="${esc(m.selector)}">${esc(m.name)}${m.vision ? ' · reads images' : ''}</option>`).join('') || '<option>All enabled models are in the chain</option>'}</select>
                <button class="ghost" data-act="add-fallback" ${addable.length ? '' : 'disabled'}>Add backup</button>
            </div>
            <p class="fineprint">Tip: all OpenRouter free models share one daily limit. Keep a model from another provider, like Gemini, at the bottom: it has its own limit and keeps you working when OpenRouter's runs out.</p>
            ${saveBar('save-fallback', 'Save backups')}`;
    }

    function saveBar(act, label) {
        const changed = dirty();
        return `
            <div class="savebar ${changed ? 'changed' : ''}">
                <span class="muted small">${changed ? 'Unsaved changes' : 'No changes'}</span>
                <span class="grow"></span>
                <button class="ghost" data-act="reset" ${changed ? '' : 'disabled'}>Undo</button>
                <button data-act="${act}" ${changed ? '' : 'disabled'}>${label}</button>
            </div>`;
    }

    function emptyState(icon, title, text, action) {
        return `<section class="empty"><div class="empty-icon" aria-hidden="true">${icon}</div><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>${action}</section>`;
    }

    // ---------- Render ----------

    function render() {
        if (!state) {
            return;
        }
        const body = { accounts: accountsTab, providers: providersTab, models: modelsTab, fallback: fallbackTab }[tab]();
        const focusId = document.activeElement?.id;
        const caret = document.activeElement?.selectionStart;
        app.innerHTML = `
            <header class="top">
                <div class="brand">
                    <img class="logo-img" src="${esc(app.dataset.icon || '')}" alt="" width="40" height="40">
                    <div>
                        <h1>Hoppy</h1>
                        <div class="muted small">Claude accounts and other AI models, one panel</div>
                    </div>
                </div>
                <div class="top-actions">
                    ${state.quota ? chip(`${state.quota.remaining}/${state.quota.limit} free left today`, state.quota.remaining > 5 ? '' : 'warn', 'OpenRouter free requests left today, shared by all free models. Resets 00:00 UTC.') : ''}
                    ${chip(state.gateway ? 'Other AI ready' : 'Other AI stopped', state.gateway ? 'ok' : 'warn', state.gateway ? 'The local connection to other AI models is running.' : 'Open the Hoppy menu and choose More → Restart Other AI.')}
                    <button class="ghost" data-act="guide">${ICON.book} Guide</button>
                </div>
            </header>
            ${routeStrip()}
            ${onboarding()}
            <nav class="tabs" role="tablist" aria-label="Settings sections">
                ${TABS.map(([id, label]) => `<button role="tab" id="tab-${id}" class="tab" aria-selected="${tab === id}" aria-controls="panel" tabindex="${tab === id ? 0 : -1}" data-tab="${id}">${label}</button>`).join('')}
            </nav>
            ${toast ? `<div class="toast ${toast.kind}" role="${toast.kind === 'error' ? 'alert' : 'status'}">${esc(toast.text)}</div>` : ''}
            <main id="panel" role="tabpanel" aria-labelledby="tab-${tab}" aria-busy="${busy}" class="${animate ? 'enter' : ''} ${busy ? 'is-busy' : ''}">${body}</main>`;
        animate = false;
        if (focusId) {
            const el = document.getElementById(focusId);
            if (el) {
                el.focus();
                if (caret != null && el.setSelectionRange) {
                    el.setSelectionRange(caret, caret);
                }
            }
        }
    }

    // ---------- Events ----------

    app.addEventListener('click', (e) => {
        const el = e.target.closest('[data-tab], [data-act]');
        if (!el || el.disabled) {
            return;
        }
        if (el.dataset.tab && !el.dataset.act) {
            return setTab(el.dataset.tab);
        }
        const act = el.dataset.act;
        const i = Number(el.dataset.i);
        if (busy && MUTATING.has(act)) {
            return;
        }
        switch (act) {
            case 'goto':
                return setTab(el.dataset.tab);
            case 'guide':
                return vscode.postMessage({ type: 'openGuide' });
            case 'switch':
                return vscode.postMessage({ type: 'switchTarget', dir: el.dataset.dir });
            case 'rename':
                return vscode.postMessage({ type: 'renameAccount', dir: el.dataset.dir });
            case 'add-account':
                return vscode.postMessage({ type: 'addAccount' });
            case 'setup':
                return vscode.postMessage({ type: 'runSetup' });
            case 'url':
                return vscode.postMessage({ type: 'openUrl', url: el.dataset.url });
            case 'save-key': {
                const p = el.dataset.provider;
                const input = document.getElementById(`key-${p}`);
                if (!input.value.trim()) {
                    input.focus();
                    return;
                }
                const hasModels = state.providers.find((x) => x.id === p)?.models.length > 0;
                vscode.postMessage({ type: 'saveKey', provider: p, key: input.value, hasModels });
                input.value = '';
                return;
            }
            case 'refresh-catalog':
                return vscode.postMessage({ type: 'refreshCatalog' });
            case 'save-models':
                return vscode.postMessage({ type: 'saveModels', enabled: [...draftEnabled], mainModel: draftMain, smallModel: draftSmall });
            case 'save-fallback':
                return vscode.postMessage({ type: 'saveFallback', models: draftFallback });
            case 'reset':
                resetDrafts();
                return render();
            case 'up':
                [draftFallback[i - 1], draftFallback[i]] = [draftFallback[i], draftFallback[i - 1]];
                return render();
            case 'down':
                [draftFallback[i + 1], draftFallback[i]] = [draftFallback[i], draftFallback[i + 1]];
                return render();
            case 'remove':
                draftFallback.splice(i, 1);
                return render();
            case 'add-fallback': {
                const v = document.getElementById('add-fallback').value;
                if (v && state.catalog.some((m) => m.selector === v)) {
                    draftFallback.push(v);
                }
                return render();
            }
        }
    });

    // Arrow keys move between tabs (WAI-ARIA tabs pattern).
    app.addEventListener('keydown', (e) => {
        if (e.target.getAttribute('role') !== 'tab') {
            if (e.key === 'Enter' && e.target.id?.startsWith('key-')) {
                document.querySelector(`[data-act="save-key"][data-provider="${e.target.id.slice(4)}"]`)?.click();
            }
            return;
        }
        const ids = TABS.map(([id]) => id);
        const at = ids.indexOf(tab);
        const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ids.length - 1 }[e.key];
        if (next !== undefined) {
            e.preventDefault();
            setTab(ids[(next + ids.length) % ids.length], true);
        }
    });

    app.addEventListener('change', (e) => {
        const el = e.target;
        if (el.dataset.act === 'toggle') {
            if (busy) {
                el.checked = !el.checked;
                return;
            }
            return vscode.postMessage({ type: 'toggleProvider', provider: el.dataset.provider, enabled: el.checked });
        }
        if (el.dataset.act === 'model') {
            el.checked ? draftEnabled.add(el.dataset.sel) : draftEnabled.delete(el.dataset.sel);
            return render();
        }
        if (el.id === 'main') {
            draftMain = el.value;
            render();
        } else if (el.id === 'small') {
            draftSmall = el.value;
            render();
        } else if (el.id === 'free-only') {
            freeOnly = el.checked;
            render();
        } else if (el.id === 'enabled-only') {
            enabledOnly = el.checked;
            render();
        }
    });

    app.addEventListener('input', (e) => {
        if (e.target.id === 'search') {
            search = e.target.value;
            render();
        }
    });

    window.addEventListener('message', (e) => {
        const m = e.data;
        if (m.type === 'state') {
            state = m;
            busy = false;
            resetDrafts();
            if (toast?.kind === 'busy') {
                toast = null;
            }
            if (m.initialTab) {
                tab = m.initialTab;
                animate = true;
                vscode.setState({ tab });
            }
            render();
        } else if (m.type === 'setTab') {
            setTab(m.tab);
        } else if (m.type === 'toast') {
            toast = { kind: m.kind, text: m.text };
            busy = m.kind === 'busy';
            render();
        } else if (m.type === 'keyResult') {
            keyResults[m.provider] = { ok: m.ok, message: m.message };
            render();
        } else if (m.type === 'focusKey') {
            setTab('providers');
            document.getElementById(`key-${m.provider}`)?.focus();
        }
    });

    vscode.postMessage({ type: 'ready' });
})();

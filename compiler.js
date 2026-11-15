// ============================================================
//  MORSE CODE COMPILER — Compiler Phases Visualizer
//  Load AFTER script.js:  <script src="compiler.js"></script>
//  Reuses: MORSE_CODE, MORSE_REVERSE, audio, textToMorse,
//          getUnitDuration, textInput, encoderTab/decoderTab/panels
// ============================================================
(() => {
'use strict';

// ---------- helpers ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const SVGNS = 'http://www.w3.org/2000/svg';

// ============================================================
//  PHASE 1 — LEXICAL ANALYSIS  (characters → tokens)
// ============================================================
function lexer(src) {
    const raw = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '.')      { raw.push({ type: 'DOT',  lex: '.', pos: i }); i++; }
        else if (c === '-') { raw.push({ type: 'DASH', lex: '-', pos: i }); i++; }
        else if (c === '/') { raw.push({ type: 'WORD_SEP', lex: '/', pos: i }); i++; }
        else if (/\s/.test(c)) {
            let j = i; while (j < src.length && /\s/.test(src[j])) j++;
            raw.push({ type: 'LETTER_SEP', lex: src.slice(i, j), pos: i }); i = j;
        } else {
            const cp = String.fromCodePoint(src.codePointAt(i));
            raw.push({ type: 'ERROR', lex: cp, pos: i }); i += cp.length;
        }
    }
    // normalise: whitespace touching a '/' or the string edge is insignificant
    raw.forEach((t, k) => {
        if (t.type !== 'LETTER_SEP') return;
        const p = raw[k - 1], n = raw[k + 1];
        if (!p || !n || p.type === 'WORD_SEP' || n.type === 'WORD_SEP') t.skipped = true;
    });
    const counts = {};
    raw.forEach(t => { if (!t.skipped) counts[t.type] = (counts[t.type] || 0) + 1; });
    return { tokens: raw, counts, errors: raw.filter(t => t.type === 'ERROR') };
}

// ============================================================
//  PHASE 2 — PARSER  (tokens → parse tree)
//    message → word ( WORD_SEP word )*
//    word    → letter ( LETTER_SEP letter )*
//    letter  → symbol+
//    symbol  → DOT | DASH
// ============================================================
function parser(tokens) {
    const errors = [], words = [];
    let word = { type: 'Word', children: [] }, letter = null;
    const newLetter = () => ({ type: 'Letter', children: [], bad: false });
    const flushLetter = () => { if (letter) { word.children.push(letter); letter = null; } };
    const flushWord = (report) => {
        flushLetter();
        if (word.children.length) words.push(word);
        else if (report) errors.push('Empty word skipped (two "/" with nothing between them)');
        word = { type: 'Word', children: [] };
    };
    tokens.forEach(t => {
        if (t.skipped) return;
        if (t.type === 'DOT' || t.type === 'DASH') {
            letter = letter || newLetter();
            letter.children.push({ type: 'Symbol', tok: t });
        } else if (t.type === 'ERROR') {
            letter = letter || newLetter();
            letter.bad = true;
            letter.children.push({ type: 'Symbol', tok: t, bad: true });
            errors.push(`Unexpected token "${t.lex}" at position ${t.pos} — expected DOT or DASH`);
        } else if (t.type === 'LETTER_SEP') flushLetter();
        else if (t.type === 'WORD_SEP') flushWord(true);
    });
    flushWord(false);
    const tree = { type: 'Message', children: words };
    return { tree, errors };
}

// ============================================================
//  PHASE 3 — SEMANTIC ANALYSIS  (symbol-table lookup + checks)
// ============================================================
function semantic(tree) {
    const table = [], diagnostics = [];
    let li = 0;
    tree.children.forEach((w, wi) => {
        w.index = wi;
        w.children.forEach(l => {
            l.id = li++;
            l.code = l.children.map(s => s.tok.lex).join('');
            if (l.bad) { l.valid = false; l.reason = 'contains a lexical error'; }
            else if (MORSE_REVERSE[l.code]) { l.valid = true; l.char = MORSE_REVERSE[l.code]; }
            else { l.valid = false; l.reason = 'no character is defined for this sequence'; }
            table.push({ code: l.code, ch: l.char, valid: l.valid, reason: l.reason });
            if (!l.valid) diagnostics.push(`Letter #${l.id + 1} "${l.code}": ${l.reason}`);
        });
    });
    const text = tree.children.map(w => w.children.map(l => l.valid ? l.char : '?').join('')).join(' ');
    return { tree, table, diagnostics, text, letters: li };
}

// ============================================================
//  PHASE 4a — INTERMEDIATE CODE GENERATION (naive, unoptimised)
// ============================================================
function genIR(tree) {
    const code = []; let id = 0, first = true;
    tree.children.forEach(w => w.children.forEach((l, k) => {
        if (!first) {            // boundary gap BEFORE this letter
            code.push({ id: id++, op: 'OFF', units: 2, owner: l.id, tag: 'letter gap' });
            if (k === 0) code.push({ id: id++, op: 'OFF', units: 4, owner: l.id, tag: 'word gap' });
        }
        first = false;
        if (!l.valid) { code.push({ id: id++, op: 'ERR', units: 0, owner: l.id, tag: l.code }); return; }
        l.code.split('').forEach(sym => {
            code.push({ id: id++, op: 'ON', units: sym === '.' ? 1 : 3, owner: l.id, tag: l.char + (sym === '.' ? ' dot' : ' dash') });
            code.push({ id: id++, op: 'OFF', units: 1, owner: l.id, tag: 'symbol gap' });
        });
    }));
    return { code };
}

// ============================================================
//  PHASE 4b — OPTIMIZER (3 passes)
// ============================================================
const totalUnits = c => c.reduce((a, i) => a + (i.op === 'ERR' ? 0 : i.units), 0);

function optimize(code) {
    const passes = [];
    let cur = code;

    // Pass 1 — dead-code elimination: ERR instruction + the gaps that led to it
    const bad = new Set(cur.filter(i => i.op === 'ERR').map(i => i.owner));
    let removed = new Set(cur.filter(i => bad.has(i.owner)).map(i => i.id));
    let next = cur.filter(i => !removed.has(i.id));
    passes.push({ name: 'Dead-code elimination', desc: 'Invalid letters can never be transmitted. Remove their ERR instruction and the gaps that led up to them.',
        before: cur, after: next, removed, merged: new Set() });
    cur = next;

    // Pass 2 — peephole: merge adjacent OFF instructions
    let nid = 1000; const out = []; const merged = new Set();
    cur.forEach(i => {
        const p = out[out.length - 1];
        if (p && p.op === 'OFF' && i.op === 'OFF') {
            if (!p.from) {
                out[out.length - 1] = { id: nid++, op: 'OFF', units: p.units + i.units, from: [p.id, i.id], tag: 'merged gap' };
                merged.add(p.id); merged.add(i.id);
            } else { p.units += i.units; p.from.push(i.id); merged.add(i.id); }
        } else out.push({ ...i });
    });
    passes.push({ name: 'Peephole: merge adjacent silences', desc: 'Back-to-back OFF instructions collapse into one: OFF 1 + OFF 2 = OFF 3 (letter gap), and OFF 1 + 2 + 4 = OFF 7 (word gap).',
        before: cur, after: out, removed: new Set(), merged });
    cur = out;

    // Pass 3 — strip leading / trailing silence
    removed = new Set();
    let a = 0, b = cur.length;
    while (a < b && cur[a].op === 'OFF') removed.add(cur[a++].id);
    while (b > a && cur[b - 1].op === 'OFF') removed.add(cur[--b].id);
    next = cur.slice(a, b);
    passes.push({ name: 'Strip edge silence', desc: 'Silence before the first signal or after the last one carries no information.',
        before: cur, after: next, removed, merged: new Set() });
    cur = next;

    return { passes, code: cur, before: totalUnits(code), after: totalUnits(cur), countBefore: code.length, countAfter: cur.length };
}

// ============================================================
//  PHASE 4c — FINAL CODE GENERATION (timed BEEP / SLEEP program)
// ============================================================
function finalGen(code) {
    const unit = (typeof getUnitDuration === 'function') ? getUnitDuration() : 120;
    const freq = (typeof audio !== 'undefined' && audio.frequency) || 700;
    let t = 0;
    const prog = code.map(i => {
        const dur = i.units * unit, row = { start: t, dur, kind: i.op, text: i.op === 'ON' ? `BEEP   ${freq}Hz  ${dur}ms` : `SLEEP  ${dur}ms`, tag: i.tag };
        t += dur; return row;
    });
    return { prog, unit, total: t, freq };
}

// ============================================================
//  Full pipeline
// ============================================================
function compile(src) {
    const lex = lexer(src), parse = parser(lex.tokens), sem = semantic(parse.tree);
    const ir = genIR(sem.tree), opt = optimize(ir.code), fin = finalGen(opt.code);
    return { src, lex, parse, sem, ir, opt, fin };
}

function normaliseSource(raw) {
    const s = raw.trim();
    if (!s) return '';
    return /^[\s.\-\/]+$/.test(s) ? s : textToMorse(s);   // plain text → Morse first
}

// ============================================================
//  STYLES
// ============================================================
const CSS = `
.cc-panel{display:none;--cc-acc:var(--accent-primary,#8b5cf6);--cc-acc2:var(--accent-secondary,#a78bfa);--cc-fg:var(--text-primary,#e8e8f0);--cc-mut:var(--text-muted,#9090a8);--cc-card:rgba(255,255,255,.035);--cc-line:rgba(255,255,255,.09);
 --c-dot:#22d3ee;--c-dash:#a78bfa;--c-lsep:#94a3b8;--c-wsep:#fbbf24;--c-err:#f87171;--c-ok:#4ade80;color:var(--cc-fg)}
.cc-panel.cc-on{display:block}
.cc-panel *{box-sizing:border-box}
.cc-src{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.cc-src input{flex:1;min-width:220px;padding:11px 14px;border-radius:10px;border:1px solid var(--cc-line);background:rgba(0,0,0,.3);color:var(--cc-fg);font:600 16px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:2px}
.cc-btn{padding:9px 16px;border-radius:10px;border:1px solid var(--cc-line);background:var(--cc-card);color:var(--cc-fg);cursor:pointer;font:600 13px inherit;transition:.15s}
.cc-btn:hover:not(:disabled){border-color:var(--cc-acc);background:rgba(139,92,246,.15)}
.cc-btn:disabled{opacity:.4;cursor:default}
.cc-btn.primary{background:linear-gradient(135deg,var(--cc-acc),var(--cc-acc2));border-color:transparent;color:#fff}
.cc-samples{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px;font-size:12px;color:var(--cc-mut);align-items:center}
.cc-samples button{padding:4px 10px;font-size:12px}
.cc-groups{display:grid;grid-template-columns:3fr 3fr;gap:6px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--cc-mut);margin-bottom:4px}
.cc-groups div{text-align:center;padding-bottom:4px;border-bottom:2px solid var(--cc-line)}
.cc-groups div:nth-child(2){border-color:var(--cc-acc)}
.cc-stepper{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:16px}
.cc-step{position:relative;padding:10px 6px;border-radius:10px;border:1px solid var(--cc-line);background:var(--cc-card);cursor:pointer;text-align:center;transition:.2s;font-size:12px}
.cc-step b{display:flex;margin:0 auto 5px;width:24px;height:24px;border-radius:50%;align-items:center;justify-content:center;background:rgba(255,255,255,.08);font-size:12px}
.cc-step:not(:last-child)::after{content:'';position:absolute;right:-7px;top:50%;width:8px;height:2px;background:var(--cc-line)}
.cc-step.done b{background:var(--c-ok);color:#06240f}
.cc-step.active{border-color:var(--cc-acc);box-shadow:0 0 18px rgba(139,92,246,.35)}
.cc-step.active b{background:var(--cc-acc);color:#fff}
.cc-card{border:1px solid var(--cc-line);background:var(--cc-card);border-radius:14px;padding:18px;margin-bottom:12px;animation:ccIn .35s ease both}
.cc-card h3{margin:0 0 2px;font-size:18px}
.cc-card .sub{color:var(--cc-mut);font-size:13px;margin:0 0 14px;line-height:1.5}
.cc-card h4{margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:1.2px;color:var(--cc-acc2)}
.cc-io{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--cc-mut);margin-bottom:12px}
.cc-io span{padding:3px 9px;border-radius:99px;background:rgba(255,255,255,.07)}
.cc-nav{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap}
@keyframes ccIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes ccPop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
.cc-tokens{display:flex;flex-wrap:wrap;gap:6px}
.cc-tok{min-width:46px;padding:5px 7px;border-radius:9px;border:1px solid;text-align:center;animation:ccPop .3s ease both;background:rgba(0,0,0,.25)}
.cc-tok small{display:block;font-size:9px;letter-spacing:.5px;opacity:.85}
.cc-tok big{display:block;font:700 18px 'JetBrains Mono',monospace;line-height:1.3}
.cc-tok i{display:block;font-size:9px;color:var(--cc-mut);font-style:normal}
.cc-tok.skipped{opacity:.35;border-style:dashed}
.t-DOT{color:var(--c-dot);border-color:var(--c-dot)}.t-DASH{color:var(--c-dash);border-color:var(--c-dash)}
.t-LETTER_SEP{color:var(--c-lsep);border-color:var(--c-lsep)}.t-WORD_SEP{color:var(--c-wsep);border-color:var(--c-wsep)}.t-ERROR{color:var(--c-err);border-color:var(--c-err);background:rgba(248,113,113,.12)}
.cc-table{width:100%;border-collapse:collapse;font-size:13px}
.cc-table th,.cc-table td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--cc-line)}
.cc-table th{color:var(--cc-mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:1px}
.cc-table code,.cc-code{font-family:'JetBrains Mono',ui-monospace,monospace}
.cc-grammar{font:13px/1.8 'JetBrains Mono',ui-monospace,monospace;padding:12px 14px;border-radius:10px;background:rgba(0,0,0,.3);overflow-x:auto;white-space:pre}
.cc-grammar em{color:var(--cc-acc2);font-style:normal}
.cc-tree{overflow:auto;padding:10px;border-radius:10px;background:rgba(0,0,0,.25);max-height:420px}
.cc-tree svg text{font:600 11px 'JetBrains Mono',monospace;fill:#fff;text-anchor:middle;dominant-baseline:central}
.cc-tree .edge{stroke:rgba(255,255,255,.25);stroke-width:1.5;fill:none}
.cc-tree .node{animation:ccPop .4s ease both;transform-box:fill-box;transform-origin:center}
.cc-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--cc-mut);margin-top:8px}
.cc-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:middle}
.cc-msg{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.6}
.cc-msg.err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.4);color:#fecaca}
.cc-msg.ok{background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.35);color:#bbf7d0}
.cc-result{font:700 28px 'Outfit',sans-serif;letter-spacing:3px;text-align:center;padding:14px;border-radius:12px;background:rgba(0,0,0,.3);margin-top:14px;text-shadow:0 0 14px rgba(139,92,246,.6)}
.cc-result u{color:var(--c-err);text-decoration:underline dashed}
.cc-ir{font:13px 'JetBrains Mono',ui-monospace,monospace;border-radius:10px;background:rgba(0,0,0,.3);padding:6px;max-height:320px;overflow:auto}
.cc-row{display:grid;grid-template-columns:34px 52px 52px 1fr;gap:6px;padding:2px 8px;border-radius:5px;animation:ccIn .25s ease both}
.cc-row .n{color:var(--cc-mut)}.cc-row .tag{color:var(--cc-mut);font-size:11px}
.cc-row.ON .op{color:var(--c-dot)}.cc-row.OFF .op{color:var(--c-lsep)}.cc-row.ERR .op{color:var(--c-err)}
.cc-row.gone{background:rgba(248,113,113,.14);text-decoration:line-through;opacity:.7}
.cc-row.mrg{background:rgba(251,191,36,.14)}
.cc-row.new{background:rgba(74,222,128,.15)}
.cc-row.play{background:rgba(139,92,246,.45)}
.cc-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:760px){.cc-two{grid-template-columns:1fr}.cc-stepper{grid-template-columns:repeat(3,1fr)}.cc-groups{display:none}}
.cc-two h5{margin:0 0 6px;font-size:11px;color:var(--cc-mut);text-transform:uppercase;letter-spacing:1px}
.cc-pass{border-left:3px solid var(--cc-acc);padding-left:12px;margin:0 0 20px}
.cc-pass h5.t{margin:0 0 2px;font-size:14px;color:var(--cc-fg);text-transform:none;letter-spacing:0}
.cc-pass p{margin:0 0 8px;color:var(--cc-mut);font-size:13px}
.cc-stats{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
.cc-stat{flex:1;min-width:120px;padding:10px;border-radius:10px;background:rgba(0,0,0,.25);text-align:center}
.cc-stat b{display:block;font-size:22px;color:var(--cc-acc2)}.cc-stat span{font-size:11px;color:var(--cc-mut)}
.cc-wave{overflow-x:auto;border-radius:10px;background:rgba(0,0,0,.3);padding:8px}
.cc-play{display:flex;align-items:center;gap:14px;margin:12px 0}
.cc-bulb{width:34px;height:34px;border-radius:50%;background:#2a2a38;border:2px solid #44445a;transition:.05s}
.cc-bulb.on{background:#fde68a;border-color:#fbbf24;box-shadow:0 0 28px 8px rgba(251,191,36,.7)}
`;

// ============================================================
//  RENDERING — shared pieces
// ============================================================
function io(inp, out) { return `<div class="cc-io"><span>Input: ${inp}</span>→<span>Output: ${out}</span></div>`; }

function renderTree(tree, mode) {
    // layout: leaves get sequential x, parents centre over children
    let leaf = 0, maxD = 0;
    const GAP = 34, VGAP = 62;
    (function lay(n, d) {
        n.depth = d; maxD = Math.max(maxD, d);
        if (!n.children || !n.children.length) { n.x = leaf++ * GAP; return; }
        n.children.forEach(c => lay(c, d + 1));
        n.x = (n.children[0].x + n.children[n.children.length - 1].x) / 2;
    })(tree, 0);
    const W = Math.max(leaf, 1) * GAP + 50, H = (maxD + 1) * VGAP + 20, OX = 25;

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    const add = (tag, attrs, parent = svg) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };

    const colorOf = n => {
        if (n.type === 'Message') return '#7c3aed';
        if (n.type === 'Word') return '#d97706';
        if (n.type === 'Letter') return mode === 'semantic' ? (n.valid ? '#16a34a' : '#dc2626') : (n.bad ? '#dc2626' : '#2563eb');
        return n.bad ? '#dc2626' : (n.tok.type === 'DOT' ? '#0891b2' : '#7c3aed');
    };
    const labelOf = (n, i) => {
        if (n.type === 'Message') return 'Message';
        if (n.type === 'Word') return 'W' + (n.index != null ? n.index + 1 : '');
        if (n.type === 'Letter') return mode === 'semantic' ? (n.valid ? n.char : '?') : 'L';
        return n.tok.type === 'DOT' ? '•' : n.tok.type === 'DASH' ? '—' : n.tok.lex;
    };
    // edges first
    (function edges(n) { (n.children || []).forEach(c => {
        const x1 = OX + n.x, y1 = 20 + n.depth * VGAP + 13, x2 = OX + c.x, y2 = 20 + c.depth * VGAP - 13;
        add('path', { class: 'edge', d: `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}` });
        edges(c);
    }); })(tree);
    (function nodes(n) {
        const g = add('g', { class: 'node', style: `animation-delay:${n.depth * 0.18}s` });
        const cx = OX + n.x, cy = 20 + n.depth * VGAP;
        if (n.type === 'Message') add('rect', { x: cx - 30, y: cy - 13, width: 60, height: 26, rx: 13, fill: colorOf(n) }, g);
        else add('circle', { cx, cy, r: 13, fill: colorOf(n) }, g);
        const t = add('text', { x: cx, y: cy }, g); t.textContent = labelOf(n);
        const ti = add('title', {}, g);
        ti.textContent = n.type === 'Letter' ? `Letter ${n.code}${n.valid != null ? (n.valid ? ' = ' + n.char : ' (invalid)') : ''}` : n.type;
        (n.children || []).forEach(nodes);
    })(tree);

    const wrap = el('div', 'cc-tree'); wrap.appendChild(svg);
    return wrap;
}

function irRow(i, idx, cls = '', delay = 0) {
    const r = el('div', `cc-row ${i.op} ${cls}`);
    r.style.animationDelay = Math.min(delay, 1.2) + 's';
    const txt = i.op === 'ERR' ? `"${esc(i.tag)}"` : i.units + 'u';
    r.innerHTML = `<span class="n">${String(idx).padStart(2, '0')}</span><span class="op">${i.op}</span><span>${txt}</span><span class="tag">${i.op === 'ERR' ? 'invalid letter' : esc(i.tag || '')}</span>`;
    return r;
}
function irList(code, classify) {
    const box = el('div', 'cc-ir');
    code.forEach((i, k) => box.appendChild(irRow(i, k, classify ? classify(i) : '', k * 0.02)));
    if (!code.length) box.innerHTML = '<div style="padding:8px;color:var(--cc-mut)">(empty program)</div>';
    return box;
}

// ============================================================
//  RENDERING — the six stages
// ============================================================
const STAGES = [
    { name: 'Lexical', title: 'Phase 1 · Lexical Analysis', sub: 'The lexer scans the raw character stream left-to-right and groups characters into tokens (the smallest meaningful units). Anything that is not part of the Morse alphabet becomes an ERROR token.',
      render(c) {
        const f = el('div'); f.innerHTML = io('character stream', 'token stream');
        f.innerHTML += `<h4>Source (Morse)</h4><div class="cc-grammar" style="font-size:18px;letter-spacing:3px">${esc(c.src) || '(empty)'}</div>`;
        f.innerHTML += `<h4>Token stream · ${c.lex.tokens.filter(t => !t.skipped).length} tokens</h4>`;
        const box = el('div', 'cc-tokens');
        const shown = { DOT: '•', DASH: '—', LETTER_SEP: '␣', WORD_SEP: '/' };
        c.lex.tokens.forEach((t, k) => {
            const d = el('div', `cc-tok t-${t.type}${t.skipped ? ' skipped' : ''}`);
            d.style.animationDelay = Math.min(k * 0.04, 1.5) + 's';
            d.innerHTML = `<small>${t.type}</small><big>${esc(shown[t.type] || t.lex)}</big><i>@${t.pos}${t.skipped ? ' skipped' : ''}</i>`;
            box.appendChild(d);
        });
        f.appendChild(box);
        f.innerHTML += `<h4>Token definitions</h4><table class="cc-table"><tr><th>Token</th><th>Pattern</th><th>Meaning</th><th>Count</th></tr>
          <tr><td class="t-DOT">DOT</td><td><code>.</code></td><td>short signal (1 unit)</td><td>${c.lex.counts.DOT || 0}</td></tr>
          <tr><td class="t-DASH">DASH</td><td><code>-</code></td><td>long signal (3 units)</td><td>${c.lex.counts.DASH || 0}</td></tr>
          <tr><td class="t-LETTER_SEP">LETTER_SEP</td><td><code>\\s+</code></td><td>gap between letters</td><td>${c.lex.counts.LETTER_SEP || 0}</td></tr>
          <tr><td class="t-WORD_SEP">WORD_SEP</td><td><code>/</code></td><td>gap between words</td><td>${c.lex.counts.WORD_SEP || 0}</td></tr>
          <tr><td class="t-ERROR">ERROR</td><td><code>any other</code></td><td>lexical error</td><td>${c.lex.counts.ERROR || 0}</td></tr></table>`;
        f.innerHTML += c.lex.errors.length
            ? `<div class="cc-msg err"><b>${c.lex.errors.length} lexical error(s):</b> ${c.lex.errors.map(t => `"${esc(t.lex)}" at position ${t.pos}`).join(', ')}</div>`
            : `<div class="cc-msg ok">No lexical errors — every character belongs to the Morse alphabet.</div>`;
        return f;
      } },
    { name: 'Parser', title: 'Phase 2 · Syntax Analysis (Parser)', sub: 'The parser checks that the token stream follows the grammar and builds a parse tree that captures the structure: message → words → letters → symbols.',
      render(c) {
        const f = el('div'); f.innerHTML = io('token stream', 'parse tree');
        f.innerHTML += `<h4>Grammar (CFG)</h4><div class="cc-grammar"><em>message</em> → <em>word</em> ( WORD_SEP <em>word</em> )*
<em>word</em>    → <em>letter</em> ( LETTER_SEP <em>letter</em> )*
<em>letter</em>  → <em>symbol</em>+
<em>symbol</em>  → DOT | DASH</div><h4>Parse tree</h4>`;
        f.appendChild(renderTree(c.parse.tree, 'syntax'));
        f.innerHTML += `<div class="cc-legend"><span><i style="background:#7c3aed"></i>Message</span><span><i style="background:#d97706"></i>Word</span><span><i style="background:#2563eb"></i>Letter</span><span><i style="background:#0891b2"></i>DOT</span><span><i style="background:#7c3aed"></i>DASH</span><span><i style="background:#dc2626"></i>Error</span></div>`;
        f.innerHTML += c.parse.errors.length
            ? `<div class="cc-msg err"><b>Syntax errors:</b><br>${c.parse.errors.map(esc).join('<br>')}</div>`
            : `<div class="cc-msg ok">Syntax OK — ${c.parse.tree.children.length} word(s), ${c.sem.letters} letter(s).</div>`;
        return f;
      } },
    { name: 'Semantic', title: 'Phase 3 · Semantic Analysis', sub: 'Structure alone is not enough: each letter node is checked against the symbol table (the Morse dictionary) to see if it actually means something. Valid letters get a decoded character attribute.',
      render(c) {
        const f = el('div'); f.innerHTML = io('parse tree', 'annotated tree + decoded text');
        f.innerHTML += '<h4>Annotated parse tree</h4>';
        f.appendChild(renderTree(c.sem.tree, 'semantic'));
        f.innerHTML += `<div class="cc-legend"><span><i style="background:#16a34a"></i>valid letter (char attribute)</span><span><i style="background:#dc2626"></i>semantic error</span></div>`;
        f.innerHTML += '<h4>Symbol-table lookups</h4><table class="cc-table"><tr><th>#</th><th>Sequence</th><th>Character</th><th>Status</th></tr>' +
            c.sem.table.map((r, k) => `<tr><td>${k + 1}</td><td><code>${esc(r.code)}</code></td><td><b>${r.valid ? esc(r.ch) : '?'}</b></td><td style="color:var(--c-${r.valid ? 'ok' : 'err'})">${r.valid ? '✔ found' : '✘ ' + esc(r.reason)}</td></tr>`).join('') + '</table>';
        f.innerHTML += c.sem.diagnostics.length
            ? `<div class="cc-msg err"><b>Semantic errors:</b><br>${c.sem.diagnostics.map(esc).join('<br>')}</div>`
            : `<div class="cc-msg ok">Semantics OK — all letters are defined.</div>`;
        f.innerHTML += `<div class="cc-result">${esc(c.sem.text).replace(/\?/g, '<u>?</u>') || '—'}</div>`;
        return f;
      } },
    { name: 'Intermediate', title: 'Phase 4a · Intermediate Code Generation', sub: 'The validated tree is walked and translated into a machine-independent instruction list: ON n / OFF n (n in time units; dot = 1, dash = 3). This first version is deliberately naive — it emits every gap separately.',
      render(c) {
        const f = el('div'); f.innerHTML = io('annotated tree', 'IR (ON / OFF / ERR)');
        f.innerHTML += `<h4>Intermediate code · ${c.ir.code.length} instructions · ${totalUnits(c.ir.code)} time units</h4>`;
        f.appendChild(irList(c.ir.code));
        f.innerHTML += `<div class="cc-legend"><span><i style="background:var(--c-dot)"></i>ON = signal</span><span><i style="background:var(--c-lsep)"></i>OFF = silence</span><span><i style="background:var(--c-err)"></i>ERR = invalid letter</span></div>`;
        return f;
      } },
    { name: 'Optimizer', title: 'Phase 4b · Code Optimization', sub: 'Three passes run over the IR. Red rows are removed, amber rows are merged, green rows are newly produced. The program sounds identical, but is smaller and cleaner.',
      render(c) {
        const f = el('div'); f.innerHTML = io('IR', 'optimised IR');
        c.opt.passes.forEach((p, n) => {
            const sec = el('div', 'cc-pass');
            sec.innerHTML = `<h5 class="t">Pass ${n + 1}: ${p.name}</h5><p>${p.desc}</p>`;
            const two = el('div', 'cc-two');
            const L = el('div'), R = el('div');
            L.innerHTML = `<h5>Before · ${p.before.length}</h5>`; R.innerHTML = `<h5>After · ${p.after.length}</h5>`;
            L.appendChild(irList(p.before, i => p.removed.has(i.id) ? 'gone' : p.merged.has(i.id) ? 'mrg' : ''));
            R.appendChild(irList(p.after, i => i.from ? 'new' : ''));
            two.append(L, R); sec.appendChild(two); f.appendChild(sec);
        });
        const st = el('div', 'cc-stats');
        st.innerHTML = `<div class="cc-stat"><b>${c.opt.countBefore} → ${c.opt.countAfter}</b><span>instructions</span></div>
            <div class="cc-stat"><b>${c.opt.before} → ${c.opt.after}</b><span>time units</span></div>
            <div class="cc-stat"><b>${c.opt.countBefore ? Math.round((1 - c.opt.countAfter / c.opt.countBefore) * 100) : 0}%</b><span>fewer instructions</span></div>`;
        f.appendChild(st);
        return f;
      } },
    { name: 'Final Code', title: 'Phase 4c · Final Code Generation', sub: 'The optimised IR is lowered to target code: concrete BEEP / SLEEP instructions with real millisecond timings, based on the speed slider. Press Execute to run the program on the audio + bulb "hardware".',
      render(c) {
        const f = el('div'); f.innerHTML = io('optimised IR', 'timed target program');
        const { prog, total, unit, freq } = c.fin;
        const bulb = el('div', 'cc-bulb'), runBtn = el('button', 'cc-btn primary', '▶ Execute program');
        const play = el('div', 'cc-play'); play.append(bulb, runBtn, el('span', '', `<span style="color:var(--cc-mut);font-size:12px">1 unit = ${unit}ms · tone ${freq}Hz · total ${(total / 1000).toFixed(2)}s</span>`));
        f.appendChild(play);

        // waveform
        f.insertAdjacentHTML('beforeend', '<h4>Signal timeline</h4>');
        const scale = Math.max(0.12, Math.min(1, 900 / Math.max(total, 1)));
        const w = Math.max(total * scale, 300) + 20;
        const wave = el('div', 'cc-wave');
        wave.innerHTML = `<svg width="${w}" height="64"><line x1="0" y1="52" x2="${w}" y2="52" stroke="rgba(255,255,255,.2)"/>` +
            prog.filter(p => p.kind === 'ON').map(p => `<rect x="${10 + p.start * scale}" y="10" width="${Math.max(p.dur * scale, 1)}" height="42" rx="3" fill="${p.dur > unit * 2 ? '#a78bfa' : '#22d3ee'}"><title>${esc(p.tag)} @${p.start}ms</title></rect>`).join('') + '</svg>';
        f.appendChild(wave);

        f.insertAdjacentHTML('beforeend', `<h4>Target program · ${prog.length} instructions</h4>`);
        const box = el('div', 'cc-ir'), rows = [];
        prog.forEach((p, k) => {
            const r = el('div', `cc-row ${p.kind}`); r.style.gridTemplateColumns = '34px 70px 1fr 1fr'; r.style.animationDelay = Math.min(k * 0.02, 1.2) + 's';
            r.innerHTML = `<span class="n">${String(k).padStart(2, '0')}</span><span class="n">${p.start}ms</span><span class="op">${p.text}</span><span class="tag">${esc(p.tag || '')}</span>`;
            box.appendChild(r); rows.push(r);
        });
        f.appendChild(box);

        let running = false, cancel = false;
        runBtn.onclick = async () => {
            if (running) { cancel = true; return; }
            if (!prog.length) return;
            running = true; cancel = false; runBtn.textContent = '■ Stop';
            if (typeof audio !== 'undefined') audio.init();
            for (let k = 0; k < prog.length && !cancel; k++) {
                rows.forEach(r => r.classList.remove('play')); rows[k].classList.add('play');
                rows[k].scrollIntoView({ block: 'nearest' });
                if (prog[k].kind === 'ON') { bulb.classList.add('on'); if (typeof audio !== 'undefined') audio.beep(prog[k].dur); }
                await wait(prog[k].dur);
                bulb.classList.remove('on');
            }
            rows.forEach(r => r.classList.remove('play'));
            running = false; runBtn.textContent = '▶ Execute program';
        };
        f._cleanup = () => { cancel = true; };
        return f;
      } },
];

// ============================================================
//  UI SHELL
// ============================================================
function init() {
    if (typeof encoderTab === 'undefined' || !encoderTab || !decoderPanel) { console.warn('compiler.js: load after script.js'); return; }

    const style = el('style', '', CSS); document.head.appendChild(style);

    // tab
    const tab = el('button', encoderTab.className.replace(/\bactive\b/g, '').trim(), '⚙ Compiler');
    tab.id = 'compilerTab'; encoderTab.parentElement.appendChild(tab);

    // panel
    const panel = el('section', 'cc-panel');
    panel.innerHTML = `
      <div class="cc-src"><input id="ccInput" spellcheck="false" placeholder="Morse (... --- ...) or plain text"><button class="cc-btn primary" id="ccCompile">Compile ▸</button></div>
      <div class="cc-samples">Try:
        <button class="cc-btn" data-s="... --- ... / .... . .-.. .--.">SOS HELP</button>
        <button class="cc-btn" data-s="HELLO WORLD">HELLO WORLD (text)</button>
        <button class="cc-btn" data-s="... --- ... / ......- / .-.-.- X -.-.-">With errors</button></div>
      <div class="cc-groups"><div>Analysis (front-end)</div><div>Code Generation (back-end)</div></div>
      <div class="cc-stepper" id="ccStepper"></div>
      <div id="ccStage"></div>
      <div class="cc-nav"><button class="cc-btn" id="ccPrev">◀ Previous</button>
        <button class="cc-btn" id="ccAuto">⏵ Run all phases</button><button class="cc-btn primary" id="ccNext">Next phase ▶</button></div>`;
    decoderPanel.after(panel);
    const $p = s => panel.querySelector(s);
    const input = $p('#ccInput'), stepper = $p('#ccStepper'), stage = $p('#ccStage');
    const prev = $p('#ccPrev'), next = $p('#ccNext'), autoBtn = $p('#ccAuto');

    let ctx = null, cur = 0, autoRun = false;

    STAGES.forEach((s, i) => {
        const d = el('div', 'cc-step', `<b>${i + 1}</b>${s.name}`);
        d.onclick = () => { autoRun = false; go(i); };
        stepper.appendChild(d);
    });

    function go(i) {
        cur = Math.max(0, Math.min(STAGES.length - 1, i));
        if (stage.firstChild && stage.firstChild._cleanup) stage.firstChild._cleanup();
        [...stepper.children].forEach((d, k) => { d.classList.toggle('active', k === cur); d.classList.toggle('done', k < cur); });
        stage.innerHTML = '';
        const card = el('div', 'cc-card', `<h3>${STAGES[cur].title}</h3><p class="sub">${STAGES[cur].sub}</p>`);
        const body = STAGES[cur].render(ctx);
        card.appendChild(body); card._cleanup = body._cleanup;
        stage.appendChild(card);
        prev.disabled = cur === 0; next.disabled = cur === STAGES.length - 1;
    }

    function run() {
        autoRun = false;
        const src = normaliseSource(input.value);
        if (!src) { if (typeof showToast === 'function') showToast('Enter some Morse code or text to compile.', 'warning'); return; }
        ctx = compile(src);
        go(0);
    }

    $p('#ccCompile').onclick = run;
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') run(); });
    input.addEventListener('keyup', e => e.stopPropagation());
    panel.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { input.value = b.dataset.s; run(); });
    prev.onclick = () => { autoRun = false; go(cur - 1); };
    next.onclick = () => { autoRun = false; go(cur + 1); };
    autoBtn.onclick = async () => {
        if (autoRun) { autoRun = false; return; }
        autoRun = true; autoBtn.textContent = '⏸ Pause'; go(0);
        while (autoRun && cur < STAGES.length - 1) { await wait(2600); if (autoRun) go(cur + 1); }
        autoRun = false; autoBtn.textContent = '⏵ Run all phases';
    };

    // tab switching (works alongside script.js's setMode)
    tab.addEventListener('click', () => {
        [encoderTab, decoderTab].forEach(t => t.classList.remove('active'));
        [encoderPanel, decoderPanel].forEach(p => p.classList.remove('active'));
        tab.classList.add('active'); panel.classList.add('cc-on');
    });
    [encoderTab, decoderTab].forEach(t => t.addEventListener('click', () => { panel.classList.remove('cc-on'); tab.classList.remove('active'); }));

    // seed from the encoder's text box if it has content
    input.value = (typeof textInput !== 'undefined' && textInput.value.trim()) || '... --- ... / .... . .-.. .--.';
    ctx = compile(normaliseSource(input.value)); go(0);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
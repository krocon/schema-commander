/*
 * Schema Commander – product site. One script for all pages, no dependencies, no requests.
 * Everything here is decoration or demo: the pages read completely without JavaScript.
 */
(() => {
  'use strict';
  const doc = document;
  const root = doc.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, el = doc) => el.querySelector(sel);
  const $$ = (sel, el = doc) => [...el.querySelectorAll(sel)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  root.classList.add('js');

  /* ── headings: words rise from their line ── */
  for (const head of $$('.split')) {
    let i = 0;
    const wrap = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const frag = doc.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { frag.append(' '); continue; }
            const w = el('span', 'w');
            const inner = el('span', '', part);
            inner.style.setProperty('--i', i++);
            w.append(inner);
            frag.append(w);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1 && child.tagName !== 'BR') wrap(child);
      }
    };
    wrap(head);
  }

  /* ── reveal on scroll ── */
  const arrive = (node) => {
    if (node.classList.contains('in')) return;
    node.classList.add('in');
    if (node.dataset.count) countUp(node);
    if (node.classList.contains('chat')) playChat(node);
  };
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      seen.unobserve(e.target);
      arrive(e.target);
    }
  }, { threshold: 0.01, rootMargin: '0px 0px -7% 0px' });
  // what is on screen at the start does not wait for the observer (it stays silent in a page that is not painted)
  for (const node of $$('.reveal, .split, [data-count], .chat')) {
    if (node.getBoundingClientRect().top < innerHeight) arrive(node);
    else seen.observe(node);
  }

  function countUp(node) {
    const to = parseFloat(node.dataset.count);
    const digits = (node.dataset.count.split('.')[1] || '').length;
    const text = node.firstChild;
    if (reduce) { text.textContent = to.toFixed(digits); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = clamp((t - t0) / 1400, 0, 1);
      text.textContent = (to * (1 - Math.pow(1 - k, 4))).toFixed(digits);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function playChat(chat) {
    if (reduce) { chat.classList.add('static'); return; }
    let t = 200;
    for (const item of [...chat.children]) {
      setTimeout(() => item.classList.add('on'), t);
      t += item.classList.contains('tool') ? 420 : 1100;
    }
  }

  /* ── nav and hero tilt: one scroll handler ── */
  const nav = $('.nav');
  const stage = $('.hero-stage');
  let ticking = false;
  function onScroll() {
    ticking = false;
    nav?.classList.toggle('scrolled', scrollY > 8);
    if (stage && !reduce) stage.style.setProperty('--tilt', (1 - clamp(scrollY / 520, 0, 1)).toFixed(3));
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  onScroll();

  /* ── cards: a light that follows the pointer ── */
  for (const card of $$('.card')) {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', e.clientX - r.left + 'px');
      card.style.setProperty('--my', e.clientY - r.top + 'px');
    });
  }

  /* ── story: the pinned window shows the scene of the step in view ── */
  for (const story of $$('.story')) {
    const steps = $$('.step', story);
    const scenes = $$('.story-pin .stack > *', story);
    const count = $('.story-count', story);
    const title = $('.story-pin .win-bar span', story);
    const show = (i) => {
      steps.forEach((s, k) => s.classList.toggle('on', k === i));
      scenes.forEach((s, k) => s.classList.toggle('on', k === i));
      if (count) count.textContent = `${i + 1} / ${steps.length}`;
      if (title && steps[i].dataset.title) title.textContent = steps[i].dataset.title;
    };
    // narrow screens have no pinned window: each step carries a copy of its scene (shown by the stylesheet)
    steps.forEach((s, i) => {
      if (!scenes[i]) return;
      const copy = scenes[i].cloneNode(true);
      copy.classList.remove('on');
      copy.style.position = '';
      copy.style.inset = '';
      const frame = el('figure', 'win');
      frame.setAttribute('aria-hidden', 'true');
      frame.append(copy);
      s.append(frame);
    });
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) show(steps.indexOf(e.target));
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach((s) => io.observe(s));
    show(0);
  }

  /* ── sub navigation: mark the group in view ── */
  const subLinks = $$('.subnav a[href^="#"]');
  if (subLinks.length) {
    const byId = new Map(subLinks.map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        subLinks.forEach((a) => a.classList.remove('on'));
        byId.get(e.target.id)?.classList.add('on');
      }
    }, { rootMargin: '-30% 0px -65% 0px' });
    for (const id of byId.keys()) { const target = doc.getElementById(id); if (target) io.observe(target); }
  }

  /* ── colour schemes: a swatch sets the tokens of the scene (the real values of the app) ── */
  const schemeBox = $('.schemes');
  const schemeStage = $('.scheme-stage');
  if (schemeBox && schemeStage) {
    const label = $('.win-bar span', schemeStage);
    const buttons = $$('.swatch', schemeBox);
    let current = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
    let auto = null;
    const pick = (i) => {
      current = i;
      buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
      let tokens = {};
      try { tokens = JSON.parse(buttons[i].dataset.theme || '{}'); } catch { /* keeps the scheme of the page */ }
      for (const [name, value] of Object.entries(tokens)) {
        if (/^--[a-z-]+$/.test(name) && /^#[0-9a-f]{3,8}$/i.test(value)) schemeStage.style.setProperty(name, value);
      }
      label.textContent = buttons[i].textContent.trim();
    };
    const stop = () => { clearInterval(auto); auto = null; };
    buttons.forEach((b, i) => b.addEventListener('click', () => { schemeBox.dataset.touched = '1'; stop(); pick(i); }));
    if (!reduce) {
      new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !auto && !schemeBox.dataset.touched) auto = setInterval(() => pick((current + 1) % buttons.length), 2600);
        else if (!e.isIntersecting) stop();
      }, { threshold: 0.4 }).observe(schemeStage);
      schemeBox.addEventListener('keydown', () => { schemeBox.dataset.touched = '1'; stop(); });
    }
  }

  /* ── table filter (keyboard page) ── */
  for (const input of $$('input[data-filter]')) {
    const rows = $$(input.dataset.filter);
    const none = $(input.dataset.none);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      for (const r of rows) {
        const group = r.classList.contains('group-row');
        r.hidden = !!q && (group || !r.textContent.toLowerCase().includes(q));
        if (!r.hidden && !group) shown++;
      }
      if (none) none.hidden = shown > 0;
    });
  }

  /* ── SQL as coloured lines (used by the demo; the static scenes are coloured in the HTML) ── */
  const KEYWORDS = new Set('select from where join left on group by order desc asc as and or is null not limit having inner count sum avg round date_trunc'.split(' '));
  const FUNCTIONS = new Set(['count', 'sum', 'avg', 'round', 'date_trunc']);
  function paintSql(target, text) {
    target.textContent = '';
    for (const lineText of text.split('\n')) {
      const line = el('span');
      for (const part of lineText.split(/('(?:[^']|'')*'?|--.*$|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]+\b)/)) {
        if (!part) continue;
        const low = part.toLowerCase();
        const cls = part.startsWith("'") ? 's' : part.startsWith('--') ? 'c' : /^\d/.test(part) ? 'n'
          : FUNCTIONS.has(low) ? 'f' : KEYWORDS.has(low) ? 'k' : '';
        line.append(cls ? el('span', cls, part) : part);
      }
      target.append(line);
    }
  }

  /* ── the live demo in the hero: a small shop, a few statements, a grid that sorts, filters and adds up ── */
  const demo = $('#demo');
  if (demo) sqlDemo(demo);

  function sqlDemo(box) {
    const editor = $('.demo-editor', box);
    const result = $('.demo-result', box);
    const empty = $('.demo-empty', box);
    const filter = $('.demo-filter', box);
    const rowsOut = $('[data-rows]', box);
    const statsOut = $('[data-stats]', box);
    const tabName = $('.demo-tabs .tab.on span', box);
    const nf = new Intl.NumberFormat('en-US');
    const money = (cents) => `${cents < 0 ? '-' : ''}${nf.format(Math.floor(Math.abs(cents) / 100))}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

    // the data: fixed, so the same statement always gives the same rows
    const customers = [
      [1, 'Ada Lindqvist', 'SE', '2023-02-11'], [2, 'Bruno Ferrari', 'IT', '2023-05-03'], [3, 'Chidi Okafor', 'NG', '2023-09-21'],
      [4, 'Dana Kowalski', 'PL', '2024-01-08'], [5, 'Emre Yilmaz', 'TR', '2024-03-30'], [6, 'Fiona Maier', 'DE', '2024-06-17'],
      [7, 'Goro Tanaka', 'JP', '2024-11-02'], [8, 'Hana Novak', 'CZ', '2025-04-25'],
    ];
    const products = [
      [101, 'Trail shoe', 12900, 42], [102, 'Rain jacket', 18950, 17], [103, 'Wool socks', 1490, 310], [104, 'Head torch', 3999, 0],
      [105, 'Day pack 22 l', 8900, 26], [106, 'Bottle 0.75 l', 2450, 140],
    ];
    const STATES = ['shipped', 'shipped', 'shipped', 'paid', 'shipped', 'open', 'shipped', 'cancelled'];
    const orders = [];
    let seed = 20260401;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 48; i++) {
      const month = 1 + Math.floor(i / 8);
      const day = 1 + Math.floor(rnd() * 27);
      const status = i > 43 ? 'open' : STATES[Math.floor(rnd() * STATES.length)];
      const placed = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const shipped = status === 'shipped' ? `2026-${String(month).padStart(2, '0')}-${String(Math.min(28, day + 1 + Math.floor(rnd() * 3))).padStart(2, '0')}` : null;
      orders.push([4000 + i, 1 + Math.floor(rnd() * 8), placed, status, 1490 + Math.floor(rnd() * 420) * 100 + Math.floor(rnd() * 100), shipped]);
    }
    orders.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0]));

    const col = (name, type) => ({ name, type, num: type === 'int4' || type === 'int8' || type === 'numeric' });
    const TABLES = {
      customers: { cols: [col('id', 'int4'), col('name', 'text'), col('country', 'bpchar'), col('since', 'date')], rows: customers },
      orders: { cols: [col('id', 'int4'), col('customer_id', 'int4'), col('placed_at', 'date'), col('status', 'text'), col('total', 'numeric'), col('shipped_at', 'date')], rows: orders },
      products: { cols: [col('id', 'int4'), col('name', 'text'), col('price', 'numeric'), col('stock', 'int4')], rows: products },
    };
    const QUERIES = {
      top: {
        tab: 'top-customers.sql',
        sql: "SELECT c.name, c.country,\n       count(*)     AS orders,\n       sum(o.total) AS revenue\nFROM   customers c\nJOIN   orders o ON o.customer_id = c.id\nGROUP  BY c.name, c.country\nORDER  BY revenue DESC;",
        run() {
          const rows = customers.map(([id, name, country]) => {
            const mine = orders.filter((o) => o[1] === id);
            return [name, country, mine.length, mine.reduce((s, o) => s + o[4], 0)];
          }).filter((r) => r[2] > 0).sort((a, b) => b[3] - a[3]);
          return { cols: [col('name', 'text'), col('country', 'bpchar'), col('orders', 'int8'), col('revenue', 'numeric')], rows };
        },
      },
      open: {
        tab: 'not-shipped.sql',
        sql: "SELECT id, customer_id, placed_at, status, total, shipped_at\nFROM   orders\nWHERE  shipped_at IS NULL\n  AND  status <> 'cancelled'\nORDER  BY placed_at;",
        run: () => ({ cols: TABLES.orders.cols, rows: orders.filter((o) => o[5] === null && o[3] !== 'cancelled') }),
      },
      month: {
        tab: 'revenue.sql',
        sql: "SELECT date_trunc('month', placed_at) AS month,\n       count(*)             AS orders,\n       sum(total)           AS revenue,\n       round(avg(total), 2) AS average\nFROM   orders\nGROUP  BY 1\nORDER  BY 1;",
        run() {
          const by = new Map();
          for (const o of orders) { const m = o[2].slice(0, 7) + '-01'; by.set(m, [...(by.get(m) || []), o[4]]); }
          const rows = [...by].map(([m, totals]) => {
            const sum = totals.reduce((s, t) => s + t, 0);
            return [m, totals.length, sum, Math.round(sum / totals.length)];
          });
          return { cols: [col('month', 'date'), col('orders', 'int8'), col('revenue', 'numeric'), col('average', 'numeric')], rows };
        },
      },
    };
    for (const name of Object.keys(TABLES)) {
      QUERIES[name] = { tab: name, sql: `SELECT *\nFROM   ${name};`, run: () => TABLES[name] };
    }

    let data = { cols: [], rows: [] };
    let view = [];
    let sort = null; // { c, dir }
    let query = '';
    let anchor = null;
    let focus = null;
    let dragging = false;
    let token = 0;

    const show = (c, v) => (v === null ? 'NULL' : c.type === 'numeric' ? money(v) : String(v));

    function compute() {
      view = data.rows.filter((r) => !query || r.some((v, i) => show(data.cols[i], v).toLowerCase().includes(query)));
      if (sort) {
        const { c, dir } = sort;
        view = [...view].sort((a, b) => {
          if (a[c] === null || b[c] === null) return a[c] === b[c] ? 0 : a[c] === null ? 1 : -1; // NULL last, either way
          return (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * dir;
        });
      }
    }

    function draw(fresh) {
      const table = el('table', 'grid');
      const head = el('tr');
      head.append(el('th', 'rn', '#'));
      data.cols.forEach((c, i) => {
        const th = el('th', c.num ? 'num' : '', c.name);
        th.append(el('small', '', c.type));
        th.scope = 'col';
        if (sort && sort.c === i) th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending');
        th.addEventListener('click', () => {
          sort = !sort || sort.c !== i ? { c: i, dir: 1 } : sort.dir > 0 ? { c: i, dir: -1 } : null;
          anchor = focus = null;
          compute(); draw(false);
        });
        head.append(th);
      });
      const thead = el('thead');
      thead.append(head);
      const body = el('tbody');
      view.forEach((r, y) => {
        const tr = el('tr', fresh && !reduce ? 'in' : '');
        tr.style.setProperty('--r', Math.min(y, 24));
        tr.append(el('td', 'rn', String(y + 1)));
        r.forEach((v, x) => {
          const td = el('td', v === null ? 'null' : data.cols[x].num ? 'num' : '', show(data.cols[x], v));
          td.dataset.x = x;
          td.dataset.y = y;
          tr.append(td);
        });
        body.append(tr);
      });
      table.append(thead, body);
      result.querySelector('table')?.remove();
      result.prepend(table);
      empty.classList.toggle('on', view.length === 0);
      rowsOut.textContent = view.length === data.rows.length ? `${view.length} rows` : `${view.length} of ${data.rows.length} rows`;
      mark();
    }

    // the selection is a rectangle of the view; the figures are added up in whole cents, never as floats
    function mark() {
      const cells = $$('td[data-x]', result);
      let count = 0;
      const nums = [];
      let scale = null;
      if (anchor && focus) {
        const [x0, x1] = [Math.min(anchor.x, focus.x), Math.max(anchor.x, focus.x)];
        const [y0, y1] = [Math.min(anchor.y, focus.y), Math.max(anchor.y, focus.y)];
        for (const td of cells) {
          const x = +td.dataset.x, y = +td.dataset.y;
          const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
          td.classList.toggle('sel', inside);
          if (!inside) continue;
          const v = view[y][x];
          if (v === null) continue;
          count++;
          if (data.cols[x].num) { nums.push(v); scale = scale === null ? data.cols[x].type : scale === data.cols[x].type ? scale : 'mixed'; }
        }
      } else for (const td of cells) td.classList.remove('sel');
      if (!count) { statsOut.textContent = 'Mark cells: the status line adds them up'; return; }
      if (!nums.length || scale === 'mixed') { statsOut.textContent = `Count ${count}`; return; }
      const fmt = scale === 'numeric' ? money : (v) => nf.format(v);
      const sum = nums.reduce((s, v) => s + v, 0);
      const avg = scale === 'numeric' ? money(Math.round(sum / nums.length)) : (sum / nums.length).toFixed(2);
      statsOut.textContent = `Count ${count} · Sum ${fmt(sum)} · Avg ${avg} · Min ${fmt(Math.min(...nums))} · Max ${fmt(Math.max(...nums))}`;
    }
    const at = (target) => { const td = target.closest?.('td[data-x]'); return td ? { x: +td.dataset.x, y: +td.dataset.y } : null; };
    result.addEventListener('pointerdown', (e) => {
      const p = at(e.target);
      if (!p) return;
      if (e.shiftKey && anchor) focus = p; else anchor = focus = p;
      dragging = true;
      mark();
    });
    result.addEventListener('pointerover', (e) => { const p = dragging && at(e.target); if (p) { focus = p; mark(); } });
    addEventListener('pointerup', () => { dragging = false; });

    function run(name, animate) {
      const q = QUERIES[name];
      const mine = ++token;
      for (const b of $$('[data-q]', box)) b.setAttribute('aria-pressed', String(b.dataset.q === name));
      tabName.textContent = q.tab;
      const finish = () => {
        if (mine !== token) return;
        paintSql(editor, q.sql);
        data = q.run();
        sort = null; anchor = focus = null;
        compute();
        result.classList.remove('busy');
        draw(true);
      };
      if (!animate || reduce) { finish(); return; }
      // type the statement, then run it
      result.classList.add('busy');
      const t0 = performance.now();
      const type = () => {
        if (mine !== token) return;
        // by the clock, not by the tick: a throttled timer still ends in time
        const n = Math.min(q.sql.length, 7 + Math.floor(((performance.now() - t0) / 16) * 7));
        paintSql(editor, q.sql.slice(0, n));
        editor.lastElementChild?.append(el('i', 'caret'));
        if (n < q.sql.length) setTimeout(type, 16); else setTimeout(finish, 220); // a timer, not a frame: it also ends in a hidden tab
      };
      type();
    }

    for (const b of $$('[data-q]', box)) b.addEventListener('click', () => run(b.dataset.q, true));
    $('[data-act="run"]', box).addEventListener('click', () => {
      const active = $('[data-q][aria-pressed="true"]', box);
      run(active ? active.dataset.q : 'top', false);
    });
    filter.addEventListener('input', () => { query = filter.value.trim().toLowerCase(); anchor = focus = null; compute(); draw(false); });

    // start filled, with the revenue column marked: the status line shows what it is for
    run('top', false);
    anchor = { x: 3, y: 0 };
    focus = { x: 3, y: view.length - 1 };
    mark();
  }
})();

/// <reference lib="dom" />
// The element picker that runs inside browser pages, in the style of Orca's grab mode: a
// Pick button, a full-page click catcher with its own highlight and label, the details
// of the clicked element read right here, and a card for the instruction, Copy and Send.
// It is sent as source text (Function.prototype.toString), so it must not use anything
// from outside its own body: no imports, no module-level helpers.

import type { PickerUpdate, RawPick } from './protocol';

export interface PickerConfig {
  hostId: string;
  binding: string;
  global: string;
  /** `getComputedStyle` properties to read; the extension filters them. */
  styleNames: string[];
}

export function pickerScript(cfg: PickerConfig): void {
  if (window.top !== window) {
    return;
  }
  const w = window as unknown as Record<string, unknown>;
  if (w[cfg.global]) {
    return;
  }
  const call = (msg: unknown) => {
    const fn = w[cfg.binding];
    if (typeof fn === 'function') {
      (fn as (payload: string) => void)(JSON.stringify(msg));
    }
  };

  // --- reading an element ----------------------------------------------------

  const squish = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);
  const esc = (s: string) => CSS.escape(s);
  const tagOf = (e: Element) => e.tagName.toLowerCase();
  const segment = (e: Element) =>
    tagOf(e) +
    [...e.classList]
      .slice(0, 2)
      .map(c => `.${esc(c)}`)
      .join('');
  const textOf = (e: Element) => squish(e instanceof HTMLElement ? e.innerText : e.textContent);
  const unique = (sel: string) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const selectorFor = (target: Element) => {
    if (target.id && unique(`#${esc(target.id)}`)) {
      return `#${esc(target.id)}`;
    }
    const parts: string[] = [];
    for (let cur: Element | null = target; cur && cur !== document.documentElement; cur = cur.parentElement) {
      let part = segment(cur);
      const parent: Element | null = cur.parentElement;
      const self = cur;
      if (parent && [...parent.children].some(c => c !== self && c.matches(part))) {
        const same = [...parent.children].filter(c => c.tagName === self.tagName);
        part += `:nth-of-type(${same.indexOf(self) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (unique(sel)) {
        return sel;
      }
      if (cur !== target && cur.id && unique(`#${esc(cur.id)}`)) {
        parts[0] = `#${esc(cur.id)}`;
        return parts.join(' > ');
      }
    }
    return parts.join(' > ');
  };
  type Fiber = { type?: unknown; return?: Fiber | null };
  const nameOf = (t: unknown): string | undefined => {
    if (typeof t === 'function') {
      const f = t as { displayName?: string; name?: string };
      return f.displayName || f.name || undefined;
    }
    if (t && typeof t === 'object') {
      const o = t as { displayName?: string; render?: unknown; type?: unknown };
      return o.displayName || nameOf(o.render) || nameOf(o.type);
    }
    return undefined;
  };
  const reactOf = (el: Element) => {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    for (let f = key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null; f; f = f.return ?? null) {
      const name = typeof f.type === 'string' ? undefined : nameOf(f.type);
      if (name && !name.startsWith('__')) {
        return name;
      }
    }
    return undefined;
  };
  const read = (el: Element): RawPick => {
    const ancestors: Element[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      ancestors.push(p);
      if (p === document.body) {
        break;
      }
    }
    const own = textOf(el);
    const nearby: string[] = [];
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg']);
    for (const p of ancestors.slice(0, 3)) {
      for (const c of p.children) {
        if (nearby.length >= 3) {
          break;
        }
        if (c.contains(el) || c.id === cfg.hostId || skip.has(c.tagName)) {
          continue;
        }
        const t = cut(textOf(c), 110);
        if (t && t !== own && !nearby.includes(t)) {
          nearby.push(t);
        }
      }
    }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      url: location.href,
      tag: tagOf(el),
      role: el.getAttribute('role') || tagOf(el),
      selector: selectorFor(el),
      react: reactOf(el),
      text: cut(own, 500),
      nearby,
      ancestorPath: ancestors.map(tagOf).join(' > '),
      domPath: [...[...ancestors].reverse().map(segment), segment(el)].join(' > '),
      rect: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
      html: squish(el.outerHTML).slice(0, 2001),
      styles: cfg.styleNames.map(name => ({ name, value: cs.getPropertyValue(name) })),
    };
  };

  // --- UI ----------------------------------------------------------------------

  const host = document.createElement('div');
  host.id = cfg.hostId;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
*{box-sizing:border-box;font:12px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
.catcher{position:fixed;inset:0;pointer-events:all;cursor:crosshair;display:none}
.box{position:fixed;display:none;pointer-events:none;border:2px solid rgba(255,255,255,.9);border-radius:3px;background:rgba(255,255,255,.08);box-shadow:0 0 0 1px rgba(0,0,0,.3),0 2px 8px rgba(0,0,0,.15);transition:all .05s ease-out}
.box.sel{border-color:#4c8dff;background:rgba(76,141,255,.12)}
.tip{position:fixed;display:none;pointer-events:none;padding:3px 8px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:4px;background:rgba(30,30,30,.92);color:#e5e5e5;font-size:11px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.pill{position:fixed;right:16px;top:16px;pointer-events:auto;display:flex;align-items:center;gap:6px;padding:6px 12px 6px 10px;border:0;border-radius:999px;background:rgba(30,30,30,.92);color:#f2f2f2;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)}
.pill:hover{background:rgba(48,48,48,.95)}
.pill.on{background:#4c8dff;color:#fff}
.pill svg{width:14px;height:14px}
.hint{position:fixed;left:50%;top:12px;transform:translateX(-50%);display:none;pointer-events:none;padding:5px 12px;border-radius:999px;background:rgba(30,30,30,.92);color:#e5e5e5;font-size:11px}
.card{position:fixed;display:none;pointer-events:auto;width:340px;padding:10px;border-radius:10px;background:rgba(30,30,30,.96);color:#e5e5e5;box-shadow:0 8px 28px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.08)}
.head{display:flex;gap:8px;align-items:flex-start}
.thumb{width:56px;height:40px;object-fit:contain;flex:none;border-radius:4px;background:#fff}
.thumb[hidden]{display:none}
.sel-text{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:#fff}
.sub{color:#a0a0a0;margin-top:2px;font-size:11px}
input{width:100%;margin-top:8px;padding:6px 8px;border:1px solid rgba(255,255,255,.15);border-radius:6px;outline:none;background:rgba(255,255,255,.06);color:#fff}
input:focus{border-color:#4c8dff}
.row{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
button.b{border:0;border-radius:6px;padding:4px 10px;cursor:pointer;background:rgba(255,255,255,.1);color:#e5e5e5}
button.b.primary{background:#4c8dff;color:#fff}
button.b:disabled{opacity:.5;cursor:default}
.toast{position:fixed;right:16px;top:56px;display:none;max-width:360px;padding:6px 12px;border-radius:8px;background:rgba(30,30,30,.92);color:#e5e5e5;pointer-events:none}
</style>
<div class="catcher"></div>
<div class="box"></div>
<div class="tip"></div>
<div class="hint">Click an element · C copies what you hover · Esc cancels</div>
<div class="card" role="dialog" aria-label="Picked element">
  <div class="head"><img class="thumb" alt="" hidden><div><div class="sel-text"></div><div class="sub"></div></div></div>
  <input placeholder="What should change? (optional)" aria-label="Instruction for the agent" maxlength="2000">
  <div class="row"><button class="b cancel">Cancel</button><button class="b copy">Copy</button><button class="b primary send">Send</button></div>
</div>
<div class="toast" aria-live="polite"></div>
<button class="pill" title="Pick an element for your agent"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/></svg><span>Pick</span></button>`;
  const q = <T extends Element>(s: string) => root.querySelector(s) as T;
  const catcher = q<HTMLDivElement>('.catcher');
  const box = q<HTMLDivElement>('.box');
  const tip = q<HTMLDivElement>('.tip');
  const hint = q<HTMLDivElement>('.hint');
  const card = q<HTMLDivElement>('.card');
  const input = q<HTMLInputElement>('input');
  const toast = q<HTMLDivElement>('.toast');
  const pill = q<HTMLButtonElement>('.pill');
  const sendBtn = q<HTMLButtonElement>('.send');

  type State = 'idle' | 'picking' | 'capturing' | 'card' | 'delivering';
  let state: State = 'idle';
  let hovered: Element | null = null;
  let selected: Element | null = null;
  let target: string | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const showToast = (text: string) => {
    toast.textContent = text;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.style.display = 'none'), 3500);
  };
  const place = (el: Element | null, label: boolean) => {
    if (!el) {
      box.style.display = 'none';
      tip.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    if (!label) {
      tip.style.display = 'none';
      return;
    }
    const role = el.getAttribute('role');
    const text = cut(textOf(el), 40);
    tip.textContent = [
      tagOf(el),
      role && `role=${role}`,
      text && `"${text}"`,
      `${Math.round(r.width)}x${Math.round(r.height)}`,
    ]
      .filter(Boolean)
      .join('  ');
    const below = r.bottom + 6;
    Object.assign(tip.style, {
      display: 'block',
      left: `${Math.max(4, r.left)}px`,
      top: `${below + 28 > innerHeight ? Math.max(4, r.top - 28) : below}px`,
    });
  };
  const render = () => {
    const picking = state === 'picking';
    catcher.style.display = picking ? 'block' : 'none';
    hint.style.display = picking ? 'block' : 'none';
    pill.classList.toggle('on', state !== 'idle');
    q('span').textContent = state === 'idle' ? 'Pick' : 'Cancel';
    pill.title = target ? `Pick an element for ${target}` : 'Pick an element for your agent';
    card.style.display = state === 'card' || state === 'delivering' ? 'block' : 'none';
    box.classList.toggle('sel', state !== 'picking');
    sendBtn.textContent = target ? `Send to ${target}` : 'Send';
    for (const b of root.querySelectorAll<HTMLButtonElement>('.card button')) {
      b.disabled = state === 'delivering';
    }
    if (state === 'idle') {
      place(null, false);
    }
  };
  const setState = (next: State) => {
    state = next;
    render();
  };

  const startPicking = () => {
    selected = null;
    hovered = null;
    setState('picking');
  };
  const stop = () => {
    selected = null;
    hovered = null;
    host.style.display = '';
    setState('idle');
  };
  const pickNow = (el: Element, copyNow: boolean) => {
    selected = el;
    setState('capturing');
    // Out of the way for the screenshot; back when the extension answers.
    host.style.display = 'none';
    // A timer, not requestAnimationFrame: frames stop while the tab is hidden.
    setTimeout(() => {
      try {
        call({ type: 'picked', pick: read(el), copyNow });
      } catch (e) {
        host.style.display = '';
        showToast(`Pick failed: ${e instanceof Error ? e.message : String(e)}`);
        startPicking();
      }
    }, 30);
  };
  const showCard = () => {
    host.style.display = '';
    setState('card');
    place(selected, false);
    const r = selected?.getBoundingClientRect();
    const cw = 340;
    const left = Math.min(Math.max(8, r ? r.left : 8), innerWidth - cw - 8);
    const below = r ? r.bottom + 8 : 8;
    const top = below + 150 > innerHeight && r ? Math.max(8, r.top - 158) : Math.min(below, innerHeight - 158);
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    input.value = '';
    input.focus();
  };

  catcher.addEventListener('mousemove', e => {
    catcher.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    catcher.style.pointerEvents = 'all';
    if (el && el !== host && el !== document.documentElement && el !== document.body) {
      hovered = el;
      requestAnimationFrame(() => state === 'picking' && place(hovered, true));
    }
  });
  // Nothing the catcher gets reaches the page underneath.
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu']) {
    catcher.addEventListener(type, e => {
      e.preventDefault();
      e.stopPropagation();
      if (type === 'click' && hovered && state === 'picking') {
        pickNow(hovered, false);
      }
    });
  }
  pill.addEventListener('click', () => (state === 'idle' ? startPicking() : (call({ type: 'cancel' }), stop())));
  q('.cancel').addEventListener('click', () => {
    call({ type: 'cancel' });
    stop();
  });
  const deliver = (type: 'copy' | 'send') => {
    if (state === 'card') {
      setState('delivering');
      call({ type, instruction: input.value });
    }
  };
  q('.copy').addEventListener('click', () => deliver('copy'));
  sendBtn.addEventListener('click', () => deliver('send'));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      deliver(e.metaKey || e.ctrlKey ? 'copy' : 'send');
    }
  });
  // Keys typed into the card stay out of the page's own shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    host.addEventListener(type, e => e.stopPropagation());
  }
  const onKey = (e: KeyboardEvent) => {
    if (state === 'picking' && (e.key === 'Escape' || ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey))) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        call({ type: 'cancel' });
        stop();
      } else if (hovered) {
        pickNow(hovered, true);
      }
    } else if ((state === 'card' || state === 'delivering') && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      call({ type: 'cancel' });
      stop();
    }
  };
  window.addEventListener('keydown', onKey, true);
  addEventListener('scroll', () => state === 'card' && place(selected, false), true);

  const mount = () => (document.body ?? document.documentElement).appendChild(host);
  if (document.body) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }
  // Some apps replace <body> on hydration; put the picker back if it gets dropped.
  const remount = setInterval(() => {
    if (!host.isConnected) {
      mount();
    }
  }, 1000);

  w[cfg.global] = {
    /** The extension's answers; see PickerUpdate. */
    update(u: PickerUpdate) {
      switch (u.type) {
        case 'target':
          target = u.target;
          break;
        case 'card': {
          q('.sel-text').textContent = u.selector;
          q('.sub').textContent = [u.size, u.preview].filter(Boolean).join(' · ');
          const thumb = q<HTMLImageElement>('.thumb');
          thumb.hidden = !u.screenshot;
          if (u.screenshot) {
            thumb.src = u.screenshot;
          }
          showCard();
          return;
        }
        case 'delivered':
          host.style.display = '';
          showToast(u.notice);
          // Copy goes straight back to picking for the next element; Send is done.
          if (u.again) {
            startPicking();
          } else {
            stop();
          }
          return;
        case 'error':
          host.style.display = '';
          showToast(u.notice);
          setState(selected ? 'card' : 'picking');
          return;
      }
      render();
    },
    toggle() {
      if (state === 'idle') {
        startPicking();
      } else {
        call({ type: 'cancel' });
        stop();
      }
    },
    state: () => state,
    remove() {
      clearInterval(remount);
      clearTimeout(toastTimer);
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      delete w[cfg.global];
    },
  };
  render();
  call({ type: 'hello' });
}

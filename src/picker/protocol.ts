// Messages between the picker Paddock injects into browser pages and the extension. Pure; no VS Code.

import type { PageCapture } from './format';

/** `Runtime.addBinding` name the picker calls with a JSON `PickerMessage`. */
export const BINDING = '__paddockCall';
/** The picker's handle on `window`, for the extension (and tests) to drive it. */
export const PICKER_GLOBAL = '__paddockPicker';
/** Id of the picker's host element; it is never picked itself. */
export const PICKER_HOST_ID = 'paddock-picker';

/** What the page reads about a picked element; styles are raw `getComputedStyle` values. */
export interface RawPick extends PageCapture {
  html: string;
  styles: { name: string; value: string }[];
}

/** Messages from the page. The page's own scripts can call the binding too, so every message is validated. */
export type PickerMessage =
  | { type: 'hello' }
  /** `copyNow`: picked with the C key, so copy straight away without the card. */
  | { type: 'picked'; pick: RawPick; copyNow: boolean }
  | { type: 'copy'; instruction: string }
  | { type: 'send'; instruction: string }
  | { type: 'cancel' };

/** What the extension tells the picker. */
export type PickerUpdate =
  | { type: 'target'; target?: string }
  | { type: 'card'; selector: string; size: string; preview: string; screenshot?: string }
  | { type: 'delivered'; notice: string; again: boolean }
  | { type: 'error'; notice: string };

const MAX_INSTRUCTION = 2000;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function parseRect(v: unknown): PageCapture['rect'] | undefined {
  if (!v || typeof v !== 'object') {
    return undefined;
  }
  const r = v as Record<string, unknown>;
  const [x, y, width, height] = [num(r.x), num(r.y), num(r.width), num(r.height)];
  return x !== undefined && y !== undefined && width !== undefined && height !== undefined
    ? { x, y, width: Math.max(0, width), height: Math.max(0, height) }
    : undefined;
}

function parsePick(v: unknown): RawPick | undefined {
  if (!v || typeof v !== 'object') {
    return undefined;
  }
  const p = v as Record<string, unknown>;
  const rect = parseRect(p.rect);
  const fields = {
    url: str(p.url, 2048),
    tag: str(p.tag, 64),
    role: str(p.role, 64),
    selector: str(p.selector, 2000),
    text: str(p.text, 600),
    ancestorPath: str(p.ancestorPath, 2000),
    domPath: str(p.domPath, 4000),
    html: str(p.html, 2100),
  };
  if (!rect || Object.values(fields).some(f => f === undefined)) {
    return undefined;
  }
  const nearby = Array.isArray(p.nearby)
    ? p.nearby
        .slice(0, 3)
        .map(n => str(n, 200))
        .filter((n): n is string => n !== undefined)
    : [];
  const styles = Array.isArray(p.styles)
    ? p.styles
        .slice(0, 120)
        .map(s => (s && typeof s === 'object' ? (s as Record<string, unknown>) : {}))
        .map(s => ({ name: str(s.name, 64), value: str(s.value, 500) }))
        .filter((s): s is { name: string; value: string } => s.name !== undefined && s.value !== undefined)
    : [];
  return {
    ...(fields as { [K in keyof typeof fields]: string }),
    react: str(p.react, 200) || undefined,
    nearby,
    rect,
    styles,
  };
}

/** Parses a binding payload; anything unexpected is dropped. */
export function parsePickerMessage(payload: string): PickerMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'hello':
    case 'cancel':
      return { type: m.type };
    case 'picked': {
      const pick = parsePick(m.pick);
      return pick ? { type: 'picked', pick, copyNow: m.copyNow === true } : undefined;
    }
    case 'copy':
    case 'send': {
      const instruction = str(m.instruction, MAX_INSTRUCTION);
      return instruction === undefined ? undefined : { type: m.type, instruction };
    }
    default:
      return undefined;
  }
}

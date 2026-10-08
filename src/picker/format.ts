// The pick as plain text, in the layout of Orca's browser context. Pure; no VS Code.

/** What the in-page picker reads about the picked element. */
export interface PageCapture {
  url: string;
  tag: string;
  /** ARIA role attribute, else the tag. */
  role: string;
  selector: string;
  /** Nearest named React component, when the page is a React app. */
  react?: string;
  text: string;
  /** Sibling and parent text, at most three lines. */
  nearby: string[];
  ancestorPath: string;
  domPath: string;
  /** Border box in document coordinates (CSS pixels). */
  rect: { x: number; y: number; width: number; height: number };
}

/** Everything a pick holds before it is written out. */
export interface Pick extends PageCapture {
  html: string;
  styles: [string, string][];
}

export interface CdpStyle {
  name: string;
  value: string;
}

/**
 * Layout, spacing, typography and colour properties worth showing, in display
 * order, each with the values that mean "nothing set". An empty list keeps every value.
 */
const STYLE_DEFAULTS: [string, string[]][] = [
  ['display', []],
  ['position', ['static']],
  ['top', ['auto']],
  ['right', ['auto']],
  ['bottom', ['auto']],
  ['left', ['auto']],
  ['z-index', ['auto']],
  ['box-sizing', ['content-box']],
  ['width', ['auto']],
  ['height', ['auto']],
  ['min-width', ['auto', '0px']],
  ['max-width', ['none']],
  ['min-height', ['auto', '0px']],
  ['max-height', ['none']],
  ['flex-direction', ['row']],
  ['flex-wrap', ['nowrap']],
  ['flex-grow', ['0']],
  ['flex-shrink', ['1']],
  ['flex-basis', ['auto']],
  ['justify-content', ['normal']],
  ['align-items', ['normal']],
  ['align-self', ['auto']],
  ['row-gap', ['normal']],
  ['column-gap', ['normal']],
  ['grid-template-columns', ['none']],
  ['grid-template-rows', ['none']],
  ['margin-top', ['0px']],
  ['margin-right', ['0px']],
  ['margin-bottom', ['0px']],
  ['margin-left', ['0px']],
  ['padding-top', ['0px']],
  ['padding-right', ['0px']],
  ['padding-bottom', ['0px']],
  ['padding-left', ['0px']],
  ['border-top-width', ['0px']],
  ['border-right-width', ['0px']],
  ['border-bottom-width', ['0px']],
  ['border-left-width', ['0px']],
  ['border-top-left-radius', ['0px']],
  ['border-top-right-radius', ['0px']],
  ['border-bottom-right-radius', ['0px']],
  ['border-bottom-left-radius', ['0px']],
  ['overflow-x', ['visible']],
  ['overflow-y', ['visible']],
  ['font-family', []],
  ['font-size', []],
  ['font-weight', ['400']],
  ['line-height', ['normal']],
  ['letter-spacing', ['normal']],
  ['text-align', ['start']],
  ['text-transform', ['none']],
  ['text-decoration-line', ['none']],
  ['white-space', ['normal']],
  ['color', []],
  ['background-color', ['rgba(0, 0, 0, 0)', 'transparent']],
  ['background-image', ['none']],
  ['opacity', ['1']],
  ['box-shadow', ['none']],
  ['transform', ['none']],
];

/** Properties the page reads with `getComputedStyle` for `filterStyles`. */
export const STYLE_NAMES = STYLE_DEFAULTS.map(([name]) => name);

/** Four longhands that fold into one shorthand when they are all set the same. */
const SHORTHANDS: [string, string[]][] = [
  ['margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']],
  ['padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
  ['border-width', ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']],
  [
    'border-radius',
    ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  ],
  ['overflow', ['overflow-x', 'overflow-y']],
  ['gap', ['row-gap', 'column-gap']],
];

/** Keeps the non-default layout, spacing, typography and colour values of `CSS.getComputedStyleForNode`. */
export function filterStyles(computed: readonly CdpStyle[]): [string, string][] {
  const values = new Map(computed.map(s => [s.name, s.value.trim()]));
  const kept = new Map<string, string>();
  for (const [name, defaults] of STYLE_DEFAULTS) {
    const value = values.get(name);
    if (value && !defaults.includes(value)) {
      kept.set(name, value);
    }
  }
  const out: [string, string][] = [];
  const folded = new Set<string>();
  for (const [name] of STYLE_DEFAULTS) {
    if (folded.has(name) || !kept.has(name)) {
      continue;
    }
    const shorthand = SHORTHANDS.find(([, longs]) => longs[0] === name);
    if (shorthand) {
      const [short, longs] = shorthand;
      const all = longs.map(l => values.get(l));
      if (all.every(v => v === all[0])) {
        out.push([short, kept.get(name)!]);
        longs.forEach(l => folded.add(l));
        continue;
      }
    }
    out.push([name, kept.get(name)!]);
  }
  return out;
}

const HTML_LIMIT = 2000;

/** Outer HTML with whitespace runs collapsed, cut to about 2 KB. */
export function trimHtml(html: string): string {
  const flat = html.replace(/\s+/g, ' ').trim();
  return flat.length > HTML_LIMIT ? `${flat.slice(0, HTML_LIMIT)}…` : flat;
}

/** `20261008-141005-h2`: sorts by time and says what was picked. */
export function pickBaseName(at: Date, tag: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  const time = `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const slug =
    tag
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'element';
  return `${date}-${time}-${slug}`;
}

/** The browser context block; the instruction, when given, goes at the end. */
export function formatPick(pick: Pick, screenshot: string | undefined, instruction?: string): string {
  const lines = [
    `Attached browser context from ${pick.url}`,
    '',
    'Selected element:',
    pick.tag,
    `Role: ${pick.role}`,
    `Selector: ${pick.selector}`,
  ];
  if (pick.react) {
    lines.push(`React: <${pick.react}>`);
  }
  lines.push(`Dimensions: ${Math.round(pick.rect.width)}x${Math.round(pick.rect.height)}`);
  if (screenshot) {
    lines.push(`Screenshot: ${screenshot}`);
  }
  if (pick.text) {
    lines.push('', 'Text content:', pick.text);
  }
  if (pick.nearby.length) {
    lines.push('', 'Nearby context:', ...pick.nearby.map(n => `- ${n}`));
  }
  if (pick.styles.length) {
    lines.push('', 'Computed styles:', ...pick.styles.map(([k, v]) => `  ${k}: ${v}`));
  }
  lines.push('', 'HTML:', pick.html, '', `Ancestor path: ${pick.ancestorPath}`, `Full DOM path: ${pick.domPath}`);
  const note = instruction?.trim();
  if (note) {
    lines.push('', `Instruction: ${note}`);
  }
  return `${lines.join('\n')}\n`;
}

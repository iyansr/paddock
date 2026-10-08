// Puts the picker into one browser page and answers it: screenshot, Copy, Send. No VS Code.

import type { CdpSession } from './cdp';
import { filterStyles, STYLE_NAMES, trimHtml, type Pick } from './format';
import { pickerScript } from './page';
import {
  BINDING,
  parsePickerMessage,
  PICKER_GLOBAL,
  PICKER_HOST_ID,
  type PickerMessage,
  type PickerUpdate,
} from './protocol';

/** What a page's picker needs from the extension. */
export interface PickerHost {
  /** Label of the session Send types into, if there is one. */
  target(): string | undefined;
  /** Writes the pick and puts it on the clipboard; returns a short notice. */
  copy(pick: Pick, screenshot: Buffer | undefined, instruction: string): Promise<string>;
  /** Writes the pick and types its path into the target session; returns a short notice. */
  send(pick: Pick, screenshot: Buffer | undefined, instruction: string): Promise<string>;
}

/** A page that is not on screen never answers a screenshot; the pick is still worth having without it. */
const SCREENSHOT_TIMEOUT_MS = 4000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const PICKER_SOURCE = `(${pickerScript.toString()})(${JSON.stringify({
  hostId: PICKER_HOST_ID,
  binding: BINDING,
  global: PICKER_GLOBAL,
  styleNames: STYLE_NAMES,
})});`;

export class PagePicker {
  private current: { pick: Pick; screenshot?: Buffer } | undefined;
  private scriptId: string | undefined;
  private readonly stopListening: () => void;

  private constructor(
    private readonly session: CdpSession,
    private readonly host: PickerHost,
  ) {
    this.stopListening = session.on('Runtime.bindingCalled', ({ name, payload }) => {
      if (name === BINDING && typeof payload === 'string') {
        const msg = parsePickerMessage(payload);
        if (msg) {
          void this.handle(msg);
        }
      }
    });
  }

  /** Adds the picker to the page now and to every document it loads later. */
  static async attach(session: CdpSession, host: PickerHost): Promise<PagePicker> {
    const picker = new PagePicker(session, host);
    await session.send('Runtime.addBinding', { name: BINDING });
    await session.send('Page.enable');
    const { identifier } = await session.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', {
      source: PICKER_SOURCE,
    });
    picker.scriptId = identifier;
    await session.send('Runtime.evaluate', { expression: PICKER_SOURCE });
    return picker;
  }

  /** Starts picking, or cancels the pick in progress. */
  async toggle(): Promise<void> {
    await this.session.send('Runtime.evaluate', { expression: `window[${JSON.stringify(PICKER_GLOBAL)}]?.toggle()` });
  }

  /** Tells the picker who Send types into. */
  refreshTarget(): void {
    void this.update({ type: 'target', target: this.host.target() });
  }

  /** Takes the picker out of the page; the page itself stays as it was. */
  async dispose(): Promise<void> {
    this.stopListening();
    await this.session
      .send('Runtime.evaluate', { expression: `window[${JSON.stringify(PICKER_GLOBAL)}]?.remove()` })
      .catch(() => undefined);
    if (this.scriptId) {
      await this.session
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId })
        .catch(() => undefined);
    }
    await this.session.send('Runtime.removeBinding', { name: BINDING }).catch(() => undefined);
  }

  private async handle(msg: PickerMessage): Promise<void> {
    switch (msg.type) {
      case 'hello':
        this.refreshTarget();
        return;
      case 'cancel':
        this.current = undefined;
        return;
      case 'picked': {
        const { styles, html, ...rest } = msg.pick;
        const pick: Pick = { ...rest, html: trimHtml(html), styles: filterStyles(styles) };
        const screenshot = await this.screenshot(pick.rect);
        this.current = { pick, screenshot };
        if (msg.copyNow) {
          await this.deliver('copy', '');
          return;
        }
        await this.update({
          type: 'card',
          selector: pick.selector,
          size: `${Math.round(pick.rect.width)}×${Math.round(pick.rect.height)}`,
          preview: pick.text.length > 60 ? `${pick.text.slice(0, 57)}...` : pick.text,
          screenshot: screenshot && `data:image/png;base64,${screenshot.toString('base64')}`,
        });
        return;
      }
      case 'copy':
      case 'send':
        await this.deliver(msg.type, msg.instruction);
        return;
    }
  }

  private async deliver(kind: 'copy' | 'send', instruction: string): Promise<void> {
    const current = this.current;
    if (!current) {
      return;
    }
    try {
      const notice = await (kind === 'copy'
        ? this.host.copy(current.pick, current.screenshot, instruction)
        : this.host.send(current.pick, current.screenshot, instruction));
      this.current = undefined;
      // Copy goes straight back to picking for the next element; Send hands over to the agent.
      await this.update({ type: 'delivered', notice, again: kind === 'copy' });
    } catch (e) {
      await this.update({ type: 'error', notice: message(e) });
    }
  }

  private async screenshot(rect: Pick['rect']): Promise<Buffer | undefined> {
    if (rect.width < 1 || rect.height < 1) {
      return undefined;
    }
    try {
      const shot = await this.session.send<{ data: string }>(
        'Page.captureScreenshot',
        { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: true },
        SCREENSHOT_TIMEOUT_MS,
      );
      return Buffer.from(shot.data, 'base64');
    } catch {
      return undefined;
    }
  }

  private async update(u: PickerUpdate): Promise<void> {
    await this.session
      .send('Runtime.evaluate', {
        expression: `window[${JSON.stringify(PICKER_GLOBAL)}]?.update(${JSON.stringify(u)})`,
      })
      .catch(() => undefined);
  }
}

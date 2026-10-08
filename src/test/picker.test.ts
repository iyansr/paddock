import * as assert from 'assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import * as vscode from 'vscode';

import { browserApiAvailable, BrowserPickers } from '../picker/browser';
import { CdpClient, type CdpSession } from '../picker/cdp';
import type { Pick } from '../picker/format';
import type { PickerHost } from '../picker/page-picker';
import { BINDING, PICKER_GLOBAL } from '../picker/protocol';

// Runs in VS Code's integrated browser through the `browser` API proposal, the way Paddock uses it.
const PAGE = `<!doctype html><html><head><title>Picker test</title><style>
body{margin:0;font:16px sans-serif}
.spacer{height:300px}
h2{margin:0;width:300px;height:80px;background:rgb(255,0,0);color:#fff;font-size:40px;padding:10px}
</style></head><body><div class="spacer">top</div><div><section class="flex h-svh">
<p>1000+ Creators already Joined us</p>
<h2 class="max-w-[524px] text-3xl">Your All In One Creator Platform</h2>
<a href="#">Start Exploring</a>
</section></div>
<script>
function Hero() {}
window.pageClicks = 0;
document.addEventListener('click', () => window.pageClicks++);
document.querySelector('h2').__reactFiber$abc = { type: 'h2', return: { type: Hero, return: null } };
</script></body></html>`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 100; i++) {
    last = await read();
    if (ok(last)) {
      return last;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

suite('Picker in the integrated browser', function () {
  this.timeout(60_000);
  let server: Server;
  let pickers: BrowserPickers;
  let tab: vscode.BrowserTab;
  let client: CdpClient;
  let page: CdpSession;
  const received: { kind: string; pick: Pick; screenshot?: Buffer; instruction: string }[] = [];
  const host: PickerHost = {
    target: () => 'claude-1',
    copy: async (pick, screenshot, instruction) => {
      received.push({ kind: 'copy', pick, screenshot, instruction });
      return 'copied';
    },
    send: async (pick, screenshot, instruction) => {
      received.push({ kind: 'send', pick, screenshot, instruction });
      return 'sent';
    },
  };

  const evaluate = async <T>(expression: string): Promise<T> =>
    (
      await page.send<{ result: { value: T } }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    ).result.value;
  const state = () => evaluate<string | null>(`window.${PICKER_GLOBAL}?.state() ?? null`);
  /** The card's buttons sit in a closed shadow root; they call the binding like this. */
  const card = (msg: unknown) => evaluate(`window.${BINDING}(${JSON.stringify(JSON.stringify(msg))}), 1`);
  const h2Centre = async () =>
    JSON.parse(
      await evaluate<string>(
        `(() => { const r = document.querySelector('h2').getBoundingClientRect(); return JSON.stringify({ x: r.x + 20, y: r.y + 20 }); })()`,
      ),
    ) as { x: number; y: number };
  const mouse = async (type: string, at: { x: number; y: number }) =>
    page.send('Input.dispatchMouseEvent', {
      type,
      ...at,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: type === 'mouseMoved' ? 0 : 1,
      pointerType: 'mouse',
    });
  const key = async (k: string) => {
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', {
        type,
        key: k,
        code: k === 'Escape' ? 'Escape' : `Key${k.toUpperCase()}`,
        windowsVirtualKeyCode: k === 'Escape' ? 27 : k.toUpperCase().charCodeAt(0),
      });
    }
  };

  suiteSetup(async () => {
    assert.ok(browserApiAvailable(), 'the browser API proposal is enabled for tests');
    server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    pickers = new BrowserPickers(host);
    pickers.start();
    tab = await vscode.window.openBrowserTab(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    // A second CDP session of our own, to look at the page and drive the mouse.
    const s = await tab.startCDPSession();
    client = new CdpClient({
      send: m => void s.sendMessage(m),
      onMessage: h => s.onDidReceiveMessage(h),
      onClose: h => s.onDidClose(h),
      close: () => void s.close(),
    });
    const attached = new Promise<string>(resolve =>
      client.on('Target.attachedToTarget', p => resolve(p.sessionId as string)),
    );
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    page = client.session(await attached);
    await until(state, v => v === 'idle', 'the picker in the page');
  });

  suiteTeardown(async () => {
    pickers?.dispose();
    client?.close();
    await tab?.close();
    server?.close();
  });

  test('a click picks the element without the page seeing it; Copy hands it over and keeps picking', async () => {
    assert.strictEqual(await pickers.toggleActive(), true);
    await until(state, v => v === 'picking', 'pick mode');
    const at = await h2Centre();
    await mouse('mouseMoved', at);
    await sleep(150);
    await mouse('mousePressed', at);
    await mouse('mouseReleased', at);
    await until(state, v => v === 'card', 'the card');
    assert.strictEqual(await evaluate<number>('window.pageClicks'), 0);

    await card({ type: 'copy', instruction: 'make it smaller' });
    await until(
      () => received.length,
      n => n === 1,
      'Copy',
    );
    const { pick, screenshot, instruction } = received[0];
    assert.strictEqual(instruction, 'make it smaller');
    assert.strictEqual(pick.selector, 'h2.max-w-\\[524px\\].text-3xl');
    assert.strictEqual(pick.react, 'Hero');
    assert.strictEqual(pick.text, 'Your All In One Creator Platform');
    assert.deepStrictEqual(pick.nearby.slice(0, 2), ['1000+ Creators already Joined us', 'Start Exploring']);
    assert.strictEqual(pick.domPath, 'body > div > section.flex.h-svh > h2.max-w-\\[524px\\].text-3xl');
    assert.deepStrictEqual([pick.rect.width, pick.rect.height], [320, 100]);
    assert.ok(pick.styles.some(([k, v]) => k === 'padding' && v === '10px'));
    assert.ok(pick.html.startsWith('<h2 class="max-w-[524px] text-3xl">'));
    // The crop is the red element, with neither the highlight nor the page around it.
    assert.ok(screenshot, 'a screenshot');
    const corners = await evaluate<number[][]>(`(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${screenshot.toString('base64')}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return [[3, 3], [img.width - 4, img.height - 4]].map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)));
    })()`);
    assert.deepStrictEqual(corners, [
      [255, 0, 0],
      [255, 0, 0],
    ]);
    // Copy re-arms for the next element.
    await until(state, v => v === 'picking', 'pick mode again');
  });

  test('C copies the hovered element straight away; Esc leaves pick mode', async () => {
    assert.strictEqual(await state(), 'picking');
    const at = await h2Centre();
    await mouse('mouseMoved', at);
    await sleep(150);
    await key('c');
    await until(
      () => received.length,
      n => n === 2,
      'the C copy',
    );
    assert.strictEqual(received[1].kind, 'copy');
    assert.strictEqual(received[1].instruction, '');
    await until(state, v => v === 'picking', 'pick mode after C');
    await key('Escape');
    await until(state, v => v === 'idle', 'idle after Esc');
  });

  test('Send hands the pick to the agent and ends pick mode; the picker survives a reload', async () => {
    await pickers.toggleActive();
    const at = await h2Centre();
    await mouse('mouseMoved', at);
    await sleep(150);
    await mouse('mousePressed', at);
    await mouse('mouseReleased', at);
    await until(state, v => v === 'card', 'the card');
    await card({ type: 'send', instruction: 'tighter' });
    await until(
      () => received.length,
      n => n === 3,
      'Send',
    );
    assert.strictEqual(received[2].kind, 'send');
    await until(state, v => v === 'idle', 'idle after Send');

    await page.send('Page.reload');
    await sleep(500);
    await until(state, v => v === 'idle', 'the picker after reload');
  });
});

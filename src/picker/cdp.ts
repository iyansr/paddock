// A minimal Chrome DevTools Protocol client over any message channel, with flattened
// target sessions (`Target.setAutoAttach({ flatten: true })`). No VS Code.

export type Params = Record<string, unknown>;

/** Where CDP messages go and come from; VS Code's `BrowserCDPSession` fits. */
export interface CdpTransport {
  send(message: object): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

interface Message {
  id?: number;
  method?: string;
  params?: Params;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

const TIMEOUT_MS = 15_000;

/** Commands and events of one attached target. */
export interface CdpSession {
  readonly sessionId: string;
  send<T = Params>(method: string, params?: Params, timeoutMs?: number): Promise<T>;
  on(event: string, handler: (params: Params) => void): () => void;
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Map<string, Set<(params: Params, sessionId?: string) => void>>();
  private readonly closeHandlers: (() => void)[] = [];
  private closed = false;

  constructor(private readonly transport: CdpTransport) {
    transport.onMessage(m => this.receive(m));
    transport.onClose(() => this.onClosed());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Sends to the browser itself, or to one attached target when `sessionId` is set. */
  send<T = Params>(method: string, params: Params = {}, sessionId?: string, timeoutMs = TIMEOUT_MS): Promise<T> {
    if (this.closed) {
      return Promise.reject(new CdpError(method, -1, 'the browser connection is closed'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, -1, 'no answer from the browser'));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: v => resolve(v as T), reject, timer });
      this.transport.send(sessionId ? { id, method, params, sessionId } : { id, method, params });
    });
  }

  /** Listens to an event from any target; the handler gets the target's session id. */
  on(event: string, handler: (params: Params, sessionId?: string) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  session(sessionId: string): CdpSession {
    return {
      sessionId,
      send: (method, params, timeoutMs) => this.send(method, params, sessionId, timeoutMs),
      on: (event, handler) => this.on(event, (params, from) => from === sessionId && handler(params)),
    };
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.transport.close();
    this.onClosed();
  }

  private receive(raw: unknown): void {
    let msg: Message;
    try {
      msg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Message;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const call = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) {
        call.reject(new CdpError(call.method, msg.error.code, msg.error.message));
      } else {
        call.resolve(msg.result ?? {});
      }
    } else if (msg.method) {
      for (const handler of this.listeners.get(msg.method) ?? []) {
        handler(msg.params ?? {}, msg.sessionId);
      }
    }
  }

  private onClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new CdpError(call.method, -1, 'the browser connection closed'));
    }
    this.pending.clear();
    this.closeHandlers.forEach(h => h());
  }
}

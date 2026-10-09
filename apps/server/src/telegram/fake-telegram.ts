import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/**
 * A stand-in for the Telegram Bot API for tests: a real HTTP server on localhost that speaks the
 * protocol the bot uses (long-polling `getUpdates`, `sendMessage`, ...). The bot runs against it
 * exactly as it would against Telegram. Tests push updates in and read the calls the bot made.
 */
export class FakeTelegram {
  readonly calls: Call[] = [];
  /** Methods that fail: `method` → Telegram error response. */
  readonly failures = new Map<
    string,
    { status: number; description: string; parameters?: object }
  >();
  private updates: object[] = [];
  private waiting: Array<() => void> = [];
  private updateId = 1;
  private messageId = 1;
  private server = http.createServer((req, res) => void this.handle(req, res));
  /** Token the server accepts; any other gets 401 like Telegram. */
  constructor(readonly token = '123456:TEST-TOKEN') {}

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this.apiRoot;
  }

  get apiRoot(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.wake();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Queues an update for the bot's next `getUpdates`. */
  push(update: object): number {
    const id = this.updateId++;
    this.updates.push({ update_id: id, ...update });
    this.wake();
    return id;
  }

  /** A text message from a user. */
  text(from: { id: number; language_code?: string }, text: string, chatId = from.id): number {
    return this.push({
      message: {
        message_id: this.messageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        from: { is_bot: false, first_name: 'Test', ...from },
        text,
        ...(text.startsWith('/') && {
          entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
        }),
      },
    });
  }

  /** A photo, which the bot cannot take as a question. */
  photo(from: { id: number; language_code?: string }): number {
    return this.push({
      message: {
        message_id: this.messageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from.id, type: 'private' },
        from: { is_bot: false, first_name: 'Test', ...from },
        photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }],
      },
    });
  }

  /** A press of an inline button under a bot message. */
  callback(from: { id: number }, data: string, chatId = from.id): number {
    return this.push({
      callback_query: {
        id: String(this.updateId),
        from: { is_bot: false, first_name: 'Test', ...from },
        chat_instance: 'test',
        data,
        message: {
          message_id: this.messageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'private' },
          text: 'bot message',
        },
      },
    });
  }

  /** The calls of one Bot API method, in order. */
  called(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  private wake() {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  private reply(res: http.ServerResponse, status: number, body: object) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    if (!match)
      return this.reply(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, token, method] = match as unknown as [string, string, string];
    if (token !== this.token) {
      return this.reply(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    }
    this.calls.push({ method, params });

    const failure = this.failures.get(method);
    if (failure) {
      return this.reply(res, failure.status, {
        ok: false,
        error_code: failure.status,
        description: failure.description,
        ...(failure.parameters && { parameters: failure.parameters }),
      });
    }

    switch (method) {
      case 'getMe':
        return this.reply(res, 200, {
          ok: true,
          result: { id: 123456, is_bot: true, first_name: 'Test bot', username: 'test_bot' },
        });
      case 'getUpdates': {
        if (this.updates.length === 0) {
          // Long polling: hold the request until an update arrives or the timeout passes
          const timeoutMs = Math.min(Number(params.timeout ?? 0) * 1000, 2000);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            this.waiting.push(() => {
              clearTimeout(timer);
              resolve();
            });
            res.on('close', resolve);
          });
        }
        const offset = Number(params.offset ?? 0);
        this.updates = this.updates.filter((u) => (u as { update_id: number }).update_id >= offset);
        const batch = this.updates.slice();
        return this.reply(res, 200, { ok: true, result: batch });
      }
      case 'sendMessage':
        return this.reply(res, 200, {
          ok: true,
          result: {
            message_id: this.messageId++,
            date: Math.floor(Date.now() / 1000),
            chat: { id: params.chat_id, type: 'private' },
            text: params.text,
          },
        });
      default:
        return this.reply(res, 200, { ok: true, result: true });
    }
  }
}

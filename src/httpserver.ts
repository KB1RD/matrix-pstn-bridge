import * as express from 'express';
import * as EventEmitter from 'events';

import { IConfigData } from './config';
import { IBridgeDatabase } from './database';
import * as concat from 'concat-stream';


interface IBridgeHTTPServerEvents {
  on(event: 'webhook', listener: (room: string, body: Buffer) => void): this;
  once(event: 'webhook', listener: (d: { room: string, body: Buffer }) => void): this;
};

/**
 * A HTTP server used by the bridge for public access, such as for webhooks.
 */
export class BridgeHTTPServer extends EventEmitter implements IBridgeHTTPServerEvents {
  constructor(
    protected readonly config: IConfigData,
    protected readonly db: IBridgeDatabase
  ) {
    super();

    const httpserver = express();

    // Turn the body data into a raw `Buffer`
    httpserver.use((req, res, next) => {
      req.pipe(concat((data) => {
        req.body = data;
        next();
      }));
    });

    const self = this;
    httpserver.post('/webhook/:token', async (req, res) => {
      const { body, params } = req;
      const room = await db.getControlRoomFromWebhookToken(params.token);

      if (!room) {
        res.sendStatus(403);
        return;
      }
      // 204 no content -- Prevents Twilio from texting "Ok" right back.
      res.sendStatus(204);

      self.emit('webhook', { room: room, body });
    });

    httpserver.listen(config.httpserver.port, config.httpserver.bindAddress);
  }

  /**
   * Returns the full URL of a webhook from its token.
   */
  getWebhookUrl(token: string): string {
    return `${this.config.httpserver.publicBaseURL}webhook/${encodeURIComponent(token)}`;
  }
  
  /**
   * Creates a new webhook for a particular control room (replacing the old one
   * if one exists) and returns the URL.
   */
  async createWebhook(room: string): Promise<string> {
    return this.getWebhookUrl(await this.db.createWebhookToken(room));
  }
};


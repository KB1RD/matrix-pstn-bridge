import * as express from 'express';
import * as EventEmitter from 'events';

import { IConfigData } from './config';
import { IBridgeDatabase } from './database';
import * as concat from 'concat-stream';

export interface IResponseData {
  body: string;
  type?: string;
}

interface IBridgeHTTPServerEvents {
  on(
    event: 'webhook',
    listener: (
      d: { room: string, body: Buffer },
      respond: (data?: IResponseData) => void,
    ) => void,
  ): this;
  once(
    event: 'webhook',
    listener: (
      d: { room: string, body: Buffer },
      respond: (data?: IResponseData) => void,
    ) => void,
  ): this;
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

      function respond(data?: IResponseData) {
        if (!data) {
          res.sendStatus(204);
          return;
        }
        res.contentType(data.type || 'text/plain');
        res.status(200);
        res.send(data.body);
      }
      self.emit('webhook', { room: room, body }, respond);
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


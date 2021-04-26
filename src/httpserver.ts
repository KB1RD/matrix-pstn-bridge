import * as express from 'express';

import { IConfigData } from './config';
import { IBridgeDatabase } from './database';

/**
 * https://stackoverflow.com/a/55718334
 * Oh god this is so hacky.
 */
declare module 'express-serve-static-core' {
  interface Request {
    control_room?: string;
  }
}

/**
 * A HTTP server used by the bridge for public access, such as for webhooks.
 */
export class BridgeHTTPServer {
  protected readonly httpserver = express();
  constructor(
    protected readonly config: IConfigData,
    protected readonly db: IBridgeDatabase
  ) {
    this.httpserver.param('token', async (req, res, next, token) => {
      const room = await db.getControlRoomFromWebhookToken(token);

      if (!room) {
        console.log(room, token);
        res.sendStatus(403);
        return;
      }

      req.control_room = room;
      next();
    });

    this.httpserver.listen(
      config.httpserver.port,
      config.httpserver.bindAddress
    );
  }

  getModuleApp(module: string): express.Application {
    const app = express();
    this.httpserver.use(`/webhook/${encodeURIComponent(module)}/:token`, app);
    return app;
  }

  /**
   * Returns the full URL of a webhook from its token.
   */
  getWebhookUrl(module: string, token: string): string {
    return `${this.config.httpserver.publicBaseURL}webhook/${encodeURIComponent(module)}/${encodeURIComponent(token)}`;
  }
  
  /**
   * Creates a new webhook for a particular control room (replacing the old one
   * if one exists) and returns the URL.
   */
  async createWebhook(module: string, room: string): Promise<string> {
    return this.getWebhookUrl(module, await this.db.createWebhookToken(room));
  }
};

import * as Twilio from 'twilio';
import * as WS from 'ws';
import * as EventEmitter from 'events';

import { getLogger } from '../module';

const AccessToken = Twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

export interface IInvitePayload {
  callsid: string;
  sdp: string;
  preflight: boolean;
  // https://github.com/twilio/twilio-client.js/blob/d90e723a7bf5ee0651159d0bbc91512ffa079cea/lib/twilio/connection.ts#L616
  twilio: object;
}

export interface ISendMsgFunc {
  (type: 'listen', payload: { token: string }): void;
  (type: 'register', payload: { media: { audio: true } }): void;
  (type: 'invite', payload: IInvitePayload): void;
  (type: 'answer', payload: { callsid: string, sdp: string }): void;
  (type: 'hangup', payload: { callsid: string }): void;
  (type: 'cancel', payload: { callsid: string }): void;
}

const log = getLogger('twilio/sigstr');

export const PSTREAM_VERSION = '1.5';
/**
 * A stream to interact with Twilio's client SDK VoIP signalling.
 * This was both reverse-engineered from working Twilio clients and from some
 * source code [here](https://github.com/twilio/twilio-client.js/blob/master/lib/twilio/pstream.js).
 */
export class TwilioSignallingStream extends EventEmitter {
  protected _ws?: WS
  constructor(
    protected readonly token: string,
    protected readonly url = 'wss://chunderw-vpc-gll.twilio.com/signal',
  ) {
    super();
  }
  
  get ws(): WS {
    if (!this._ws) {
      throw new TypeError('Call begin() before attempting to use signalling stream');
    }
    return this._ws as WS;
  }
  
  async begin(): Promise<void> {
    this._ws = new WS(this.url);

    const promise = new Promise((r) => (this.ws.onopen = r));
    this._ws.onmessage = this._ws_message.bind(this);
    this._ws.onclose = () => log.debug('Stream closed');
    this._ws.onerror = (e) => log.warn('Stream websocket error', e);

    await promise;
    this.send('listen', { token: this.token });
    await this.on_message('connected');
    this.send('register', { media: { audio: true } });
    await this.on_message('ready');
  }
  close(): void {
    if (this._ws) {
      this._ws.close();
    }
  }

  on_message(type: string): Promise<object> {
    return new Promise((r) => this.once(`msg:${type}`, r));
  }
  
  _ws_message(e): void {
    // Keep alive
    if (e.data.trim() === '') {
      this.ws.send('\n');
      log.debug('Responding to Twilio WS keepalive');
      return;
    }

    let d;
    try {
      d = JSON.parse(e.data);
    } catch {
      log.warn(
        'Got invalid message from Twilio, unable to parse:',
        // The stringify here renders with quotes so the exact text is known
        JSON.stringify(e.data),
      );
      return;
    }
    if (typeof d.type !== 'string' || typeof d.payload !== 'object') {
      log.warn('Got invalid message from Twilio:', d);
      return;
    }
    log.debug('Got msg:', d);
    this.emit(`msg`, d.type, d.payload);
    this.emit(`msg:${d.type}`, d.payload);
  }

  public readonly send: ISendMsgFunc = (
    type: string,
    payload: object,
  ): void => {
    this.ws.send(
      JSON.stringify({ type, version: PSTREAM_VERSION, payload }),
    );
    log.debug(`Sent msg '${type}':`, payload);
  }
}

interface ISigStreamCreationData {
  /**
   * **Account** SID
   */
  sid: string;
  /**
   * Twilio [API key](https://www.twilio.com/docs/iam/keys/api-key)
   */
  apikey: { sid: string, secret: string };
  /**
   * [TwiML app](https://support.twilio.com/hc/en-us/articles/223180928-How-Do-I-Create-a-TwiML-App-) SID
   */
  appSid: string;
};

/**
 * Creates a JWT for a Twilio cliebt and creates a signalling stream with that
 * token.
 * @param creationdata - Authentication. See `ISigStreamCreationData`
 * @param identity - The client name to use
 * @param url - Optional URL for the Twilio websocket
 */
export function createSignallingStream(
  { sid, apikey, appSid }: ISigStreamCreationData,
  identity: string,
  url?: string,
): TwilioSignallingStream {
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: appSid,
    incomingAllow: true,
  });

  const token = new AccessToken(sid, apikey.sid, apikey.secret, { identity });
  token.addGrant(voiceGrant);

  return new TwilioSignallingStream(token.toJwt(), url);
}

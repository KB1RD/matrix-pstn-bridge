import * as Twilio from 'twilio';
import * as WS from 'ws';
import * as EventEmitter from 'events';

const AccessToken = Twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

export interface IInvitePayload {
  callsid: string;
  sdp: string;
  preflight: boolean;
  // https://github.com/twilio/twilio-client.js/blob/d90e723a7bf5ee0651159d0bbc91512ffa079cea/lib/twilio/connection.ts#L616
  twilio: string;
}

export interface ISendMsgFunc {
  (type: 'listen', payload: { token: string }): void;
  (type: 'register', payload: { media: { audio: true } }): void;
  (type: 'invite', payload: IInvitePayload): void;
  (type: 'answer', payload: { callsid: string, sdp: string }): void;
}

export const PSTREAM_VERSION = '1.5';
export class TwilioSignallingStream extends EventEmitter {
  protected _ws?: WS
  test = new Set<(arg: string) => void>();
  constructor(
    protected readonly token: string,
    protected readonly url = 'wss://chunderw-vpc-gll.twilio.com/signal',
  ) {
    super();
    this.on('msg', console.log);
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
    this._ws.onclose = () => console.log('WS closed');
    this._ws.onerror = (e) => console.log('WS error', e);

    await promise;
    this.send('listen', { token: this.token });
    await this.on_message('connected');
    this.send('register', { media: { audio: true } });
    await this.on_message('ready');
  }

  on_message(type: string): Promise<object> {
    return new Promise((r) => this.once(`msg:${type}`, r));
  }
  
  _ws_message(e): void {
    // Keep alive
    if (e.data.trim() === '') {
      this.ws.send('\n');
    }

    let d;
    try {
      d = JSON.parse(e.data);
    } catch {
      // TODO: Log maybe?
      return;
    }
    console.log(d);
    if (typeof d.type !== 'string' || typeof d.payload !== 'object') {
      // TODO: Log maybe?
      return;
    }
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
  }
}

interface ISigStreamCreationData {
  sid: string;
  apikey: { sid: string, secret: string };
  appSid: string;
};

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

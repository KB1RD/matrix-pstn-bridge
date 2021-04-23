import * as Twilio from 'twilio';
import * as Str from '@supercharge/strings';
import * as phone from '../phonenumber';

import { ILinkOpts, IWebhookData, IWebhookResponse, IResponseData } from './module';

import { createSignallingStream, TwilioSignallingStream } from './twilio_signalling';
import { IModule } from '.';

interface ITwilioData {
  version: 0;
  sid: string;
  authToken: string;
  apikey: { sid: string, secret: string };
  appSid: string;
};

const streams = new Map<string, TwilioSignallingStream>();

const mod: IModule = {
  friendly_name: 'Twilio',

  async tryLink(
    { webhook }: ILinkOpts,
    sid: string,
    authToken: string,
    ...numargs: string[]
  ): Promise<[string, ITwilioData]> {
    const number = (numargs && numargs.length && numargs.join(' ')) || ''
    if (!sid || !authToken || number === '') {
      throw new TypeError('Usage: link twilio [sid] [token] [number...]');
    }

    // The whole account token is necessary for voice API grants
    // An API key and TwiML app also have to be created, which is then used to
    // create a JWT token. So let's see... That's 3 ids and 2 secrets to create
    // another single use token. 6 identifiers. What the hell.
    if (!sid.startsWith('AC')) {
      throw new TypeError('The SID must be your account SID (starts with AC)');
    }

    const e164 = phone.parsePhoneNumber(number)?.E164;
    if (!e164) {
      throw new TypeError(`Invalid phone number ${number}`);
    }

    const twilio = Twilio(sid, authToken);
    let apikey: { sid: string, secret: string };
    const opts = {
      // TODO: Some form of ID here? Limited to 64 chars
      friendlyName: 'Matrix PSTN Bridge',
    };
    try {
      const { sid, secret } = await twilio.newKeys.create(opts);
      apikey = { sid, secret };
    } catch(e) {
      throw new Error(
        'Failed to create API key. Are the credentials correct?'
      );
    }
    let appSid: string;
    try {
      appSid = (await twilio.applications.create(opts)).sid;
    } catch(e) {
      throw new Error(
        'Failed to create TwiML app. Are the credentials correct?'
      );
    }

    try {
      const numbers = await twilio
        .incomingPhoneNumbers
        .list({ phoneNumber: e164 });
      if (numbers.length !== 1) {
        throw new Error(`Failed to find the number (${e164}) in your account.`);
      }
      numbers[0].smsMethod = 'POST';
      numbers[0].smsUrl = webhook;
      numbers[0].voiceMethod = 'POST';
      numbers[0].voiceUrl = webhook;
      await numbers[0].update(numbers[0]);
    } catch(e) {
      throw new Error(
        'Failed to confirm phone number. Are the credentials correct?'
      );
    }
    return [e164, { version: 0, sid, authToken, apikey, appSid }];
  },
  async getStatusMsg(data: ITwilioData): Promise<string> {
    const bal = await Twilio(data.sid, data.authToken).balance.fetch();
    return `Account balance ${bal.balance} ${bal.currency}.`;
  },

  async callAnswerRemote(rid: string, sdp: string): Promise<void> {
    const sigstream = streams.get(rid);
    if (!sigstream) {
      throw new Error(`Remote ID ${rid} does not have open signalling stream`);
    }
    sigstream.send('answer', { callsid: rid, sdp });
  },

  async *processWebhook(
    { body, config }: IWebhookData,
    respond: (data?: IResponseData) => void,
  ): AsyncIterableIterator<IWebhookResponse> {
    const parts = body.toString().split('&').map((p) => p.split('='));
    let from: string | null = null;
    let text: string | null = null;
    let sid: string | null = null;
    parts.forEach(([k, v]) => {
      v = decodeURIComponent(v.replace(/\+/g, '%20'));
      switch (k) {
        case 'From':
          from = v;
          break;
        case 'Body':
          text = v;
          break;
        case 'CallSid':
          sid = v;
          break;
      }
    });

    if (from && text) {
      yield { type: 'text', from, text };
    } else if (from && sid) {
      const id = Str.random(64);
      const sigstr = createSignallingStream(config as ITwilioData, id);
      await sigstr.begin();

      const timeout = 30;
      // Including `<?xml version="1.0" encoding="UTF-8"?>` causes it to fail,
      // even though Twilio demos include it.
      respond({ type: 'text/xml', body: `
        <Response>
          <Dial timeout="${timeout}">
            <Client>
                <Identity>${id}</Identity>
              </Client>
            </Dial>
        </Response>
      `});

      const msg = (await sigstr.on_message('invite')) as { callsid: string, sdp: string };
      if (typeof msg.callsid !== 'string' || typeof msg.sdp !== 'string') {
        throw new Error('Invalid invite message from Twilio');
      }
      // `sid` and `msg.callsid` are different. I guess it's not a *call* ID
      // but a *leg* ID?
      streams.set(msg.callsid, sigstr);
      yield {
        type: 'create-call',
        from,
        remote_id: msg.callsid,
        sdp: msg.sdp,
        timeout: timeout * 1000,
      };
      while (true) {
        const msg = await sigstr.on_message('candidate') as { callsid: string, candidate: string };
        if (typeof msg.callsid === 'string' && typeof msg.candidate === 'string') {
          yield {
            type: 'call-candidates',
            from,
            remote_id: msg.callsid,
            sdp: [msg.candidate],
          }
        }
      }
    }
  },
  async sendMessage(data: ITwilioData, from: string, to: string, body: string): Promise<void> {
    const twilio = Twilio(data.sid, data.authToken);
    await twilio.messages.create({ body, from, to });
  },
};
export default mod;

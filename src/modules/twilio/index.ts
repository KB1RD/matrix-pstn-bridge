import * as Twilio from 'twilio';
import * as Str from '@supercharge/strings';
import * as phone from '../../phonenumber';

import {
  IModule,
  ILinkOpts,
  PhoneCall,
  express,
  IWebhookHandlers,
} from '../module';

import { createSignallingStream, TwilioSignallingStream } from './signalling';
import { CallState } from '../../call';
import * as concat from 'concat-stream';

interface ITwilioData {
  version: 0;
  sid: string;
  authToken: string;
  apikey: { sid: string, secret: string };
  appSid: string;
};

interface ICallData {
  call: PhoneCall;
  sigstr: TwilioSignallingStream;
  twilio_id: string | null;
};

const calls = new WeakMap<PhoneCall, ICallData>();
const calls_by_id = new Map<string, ICallData>();

async function initCall(
  data: ITwilioData,
  call: PhoneCall,
  invite: boolean,
  init_signal: (
    sigstr: TwilioSignallingStream,
    id: string,
  ) => void | Promise<void>,
): Promise<void> {
  // The ID for this "client" signalling stream
  // Can be passed to the Dial Client TwiML directives
  const id = Str.random(64);
  const sigstr = createSignallingStream(data, id);
  await sigstr.begin();
  const cdata = { call, sigstr, twilio_id: null as string | null };
  calls.set(call, cdata);

  call.on('ended', () => {
    if (cdata.twilio_id) {
      calls_by_id.delete(cdata.twilio_id);
      sigstr.send('hangup', { callsid: cdata.twilio_id });
    }
    // Just closing the stream will eventually cause the call to hang up
    sigstr.close();
  });

  await init_signal(sigstr, id);

  await new Promise<void>((res, rej) => {
    // No call sids are checked here because...
    // 1.) There's only one call per channel in this impl
    // 2.) There's no way for me to know the call SID before it arrives in an
    // answer or hangup. Setting the call SID on the invite does nothing.
    if (invite) {
      sigstr.on('msg:invite', (msg) => {
        if (
          typeof msg !== 'object' ||
          typeof msg.sdp !== 'string' ||
          typeof msg.callsid !== 'string'
        ) {
          call.state = CallState.FAILED;
          call.emit('send_hangup');
          rej(new Error('Invalid invite message from Twilio'));
          return;
        }
        cdata.twilio_id = msg.callsid;
        calls_by_id.set(msg.callsid, cdata);
        call.emit('send_invite', msg.sdp);
        res();
      });
    } else {
      sigstr.on('msg:answer', (msg) => {
        if (
          typeof msg !== 'object' ||
          typeof msg.sdp !== 'string' ||
          typeof msg.callsid !== 'string'
        ) {
          call.state = CallState.FAILED;
          call.emit('send_hangup');
          rej(new Error('Invalid answer message from Twilio'));
          return;
        }
        cdata.twilio_id = msg.callsid;
        calls_by_id.set(msg.callsid, cdata);
        call.emit('send_accept', msg.sdp);
        res();
      });
    }
    sigstr.on('msg:candidate', (msg) => {
      if (
        typeof msg !== 'object' ||
        typeof msg.candidate !== 'string' ||
        typeof msg.label !== 'number' ||
        msg.type !== 'candidate'
      ) {
        // TODO: log
        return;
      }
      call.emit('send_candidates', [msg.sdp]);
    });
    sigstr.on('msg:hangup', () => {
      call.emit('send_hangup');
      res();
    });
    sigstr.on('msg:cancel', () => {
      call.emit('send_hangup');
      res();
    });
  });
}

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
    const opts: Record<string, string> = {
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
    opts.voiceMethod = 'POST';
    opts.voiceUrl = `${webhook}/call/outgoing`;
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
      numbers[0].smsUrl = `${webhook}/message`;
      numbers[0].voiceMethod = 'POST';
      numbers[0].voiceUrl = `${webhook}/call/incoming`;
      await numbers[0].update(numbers[0]);
    } catch(e) {
      throw new Error(
        'Failed to confirm phone number. Are the credentials correct?'
      );
    }
    return [e164, { version: 0, sid, authToken, apikey, appSid }];
  },

  registerWebhooks(app: express.Application, handlers: IWebhookHandlers) {
    // This just plain doesn't work. Body stays as `{}`. No comment.
    // app.use(bodyparser.urlencoded({ extended: false, type: '*' }));

    // If the wheel is broken, reinvent it
    app.use((req, res, next) => {
      req.pipe(concat((data) => {
        const parts = data.toString().split('&').map((p) => p.split('='));
        req.body = {};
        parts.forEach(([k, v]) => {
          v = decodeURIComponent(v.replace(/\+/g, '%20'));
          req.body[k] = v;
        });
        next();
      }));
    });

    app.post('/message', (req, res) => {
      res.sendStatus(204);

      if (
        typeof req.body.From !== 'string' ||
        typeof req.body.Body !== 'string'
      ) {
        // TODO: Log
        return;
      }
      handlers.sendText(
        // If the token is authenticated, the control room must be a string
        req.control_room as string,
        req.body.From,
        req.body.Body
      );
    });

    app.post('/call/incoming', async (req, res) => {
      const fail = () => {
        res.set('Content-Type', 'text/xml');
        res.send(`
          <Response>
            <Speak>Error processing call</Speak>
          </Response>
        `);
        res.sendStatus(200);
      };
      if (
        typeof req.body.From !== 'string' ||
        typeof req.body.CallSid !== 'string'
      ) {
        // TODO: Log
        fail();
        return;
      }

      const config = (await handlers.getConfig(
        req.control_room as string,
      )) as ITwilioData;
      if (!config) {
        // TODO: Log
        fail();
        return;
      }

      const call = await handlers.createCall(
        req.control_room as string,
        req.body.From
      );
      if (!call) {
        // The error is already logged, we just need to exit gracefully
        fail();
        return;
      }
      await initCall(config, call, true, (sigstr, id) => {
        const timeout = 60;
        // Including `<?xml version="1.0" encoding="UTF-8"?>` causes it to fail,
        // even though Twilio demos include it.
        res.set('Content-Type', 'text/xml');
        res.status(200);
        res.send(`
          <Response>
            <Dial timeout="${timeout}">
              <Client>
                <Identity>${id}</Identity>
              </Client>
            </Dial>
          </Response>
        `);
      });
    });

    app.post('/call/outgoing', async (req, res) => {
      const data = calls_by_id.get(req.body.CallSid);
      if (!data) {
        res.set('Content-Type', 'text/xml');
        res.status(200);
        res.send(`
          <Response>
            <Speak>Internal error. Failed to find call</Speak>
          </Response>
        `);
        // TODO: Log
        return;
      }

      const timeout = 30;
      res.set('Content-Type', 'text/xml');
      res.status(200);
      res.send(`
        <Response>
          <Dial timeout="${timeout}" callerId="${data.call.local}">
            <Number>${data.call.remote}</Number>
          </Dial>
        </Response>
      `);
    });
  },

  async getStatusMsg(data: ITwilioData): Promise<string> {
    const bal = await Twilio(data.sid, data.authToken).balance.fetch();
    return `Account balance ${bal.balance} ${bal.currency}.`;
  },

  async sendMessage(
    data: ITwilioData,
    from: string,
    to: string,
    body: string
  ): Promise<void> {
    const twilio = Twilio(data.sid, data.authToken);
    await twilio.messages.create({ body, from, to });
  },

  async sendCallInvite(
    data: ITwilioData,
    call: PhoneCall,
    sdp: string
  ): Promise<void> {
    await initCall(data, call, false, (sigstr) => {
      // The call SID here doesn't seem to be used anywhere again
      sigstr.send('invite', { sdp, callsid: '', preflight: false, twilio: {} });
    });
  },
  async sendCallCandidates(
    data: ITwilioData,
    call: PhoneCall,
    candidates_sdp: string[],
  ): Promise<void> {
    const cdata = calls.get(call);
    if (!cdata) {
      throw new Error('Call signalling not started with Twilio');
    }
    if (!cdata.twilio_id) {
      throw new Error('Twilio remote not yet answered, no call ID');
    }
    candidates_sdp.forEach((candidate) => {
      cdata.sigstr.send('candidate', {
        callsid: cdata.twilio_id as string,
        candidate,
        label: 0, // TODO: fix
        type: 'candidate',
      });
    });
  },
  async sendCallAccept(
    data: ITwilioData,
    call: PhoneCall,
    sdp: string,
  ): Promise<void> {
    console.log('Twilio call accept');
  },
  async sendCallHangup(): Promise<void> {
    // Call hangup handler is set up when the call is created
  },
};
export default mod;

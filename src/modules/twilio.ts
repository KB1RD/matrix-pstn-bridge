import * as Twilio from 'twilio';
import * as phone from '../phonenumber';

import { ILinkOpts, IWebhookData, IWebhookResponse } from './module';

interface ITwilioData {
  sid: string,
  authToken: string,
};

export default {
  friendly_name: 'Twilio',

  async tryLink({ webhook }: ILinkOpts, sid, authToken, ...numargs): Promise<[string, ITwilioData]> {
    const number = (numargs && numargs.length && numargs.join(' ')) || ''
    if (!sid || !authToken || number === '') {
    	throw new TypeError('Usage: link vonage [apikey] [apisecret] [number...]');
    }
    const e164 = phone.parsePhoneNumber(number)?.E164;
    if (!e164) {
    	throw new TypeError(`Invalid phone number ${number}`);
    }
    try {
    	const twilio = Twilio(sid, authToken);
    	const numbers = await twilio
    	  .incomingPhoneNumbers
    	  .list({ phoneNumber: e164 });
      if (numbers.length !== 1) {
        throw new Error(`Failed to find the number (${e164}) in your account.`);
      }
      numbers[0].smsMethod = 'POST';
      numbers[0].smsUrl = webhook;
      await numbers[0].update(numbers[0]);
    } catch(e) {
    	throw new Error('Failed to confirm phone number. Are the credentials correct?');
    }
    return [e164, { sid, authToken }];
  },
  async getStatusMsg(data: ITwilioData): Promise<string> {
    const bal = await Twilio(data.sid, data.authToken).balance.fetch();
    return `Account balance ${bal.balance} ${bal.currency}.`;
  },

  async processWebhook({ body }: IWebhookData): Promise<IWebhookResponse | null> {
    const parts = body.toString().split('&').map((p) => p.split('='));
    let from: string | null = null;
    let text: string | null = null;
    parts.forEach(([k, v]) => {
      v = decodeURIComponent(v.replace(/\+/g, '%20'));
      switch (k) {
        case 'From':
          from = v;
          break;
        case 'Body':
          text = v;
          break;
      }
    });
    if (!from || !text) {
      return null;
    }
    return { type: 'text', from, text };
  },
  async sendMessage(data: ITwilioData, from: string, to: string, body: string): Promise<void> {
    const twilio = Twilio(data.sid, data.authToken);
    await twilio.messages.create({ body, from, to });
  },
};


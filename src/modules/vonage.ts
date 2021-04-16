const Vonage = require('@vonage/server-sdk');
import * as phone from '../phonenumber';

import { ILinkOpts, IWebhookData, IWebhookResponse } from './module';

interface IVonageData {
  apiKey: string,
  apiSecret: string,
};

// CURRENTLY UNFINISHED
// I had a vonage number months ago, then I stopped having time to work on this
// so I deleted the number. Aparently, when you do that, you have to give them
// your debit card to get a new one, even if you still have trial credits.
// I was too lazy to do that.

export default {
  friendly_name: 'Vonage',

  async tryLink({ webhook }: ILinkOpts, apiKey, apiSecret, ...numargs): Promise<[string, IVonageData]> {
    const number = (numargs && numargs.length && numargs.join(' ')) || '';
    if (!apiKey || !apiSecret || number === '') {
    	throw new TypeError('Usage: link vonage [apikey] [apisecret] [number...]');
    }
    const e164 = phone.parsePhoneNumber(number)?.E164;
    if (!e164) {
    	throw new TypeError(`Invalid phone number ${number}`);
    }
    const vonage = new Vonage({ apiKey, apiSecret });
    try {
      const { numbers } = await new Promise(
        (res, rej) => vonage.number.get(
          { pattern: e164, search_pattern: 2 },
          (e, d) => e ? rej(e) : res(d),
        )
      );
      if (numbers.length !== 1) {
        throw new Error(`Failed to find the number (${e164}) in your account.`);
      }
    } catch(e) {
    	throw new Error('Failed to confirm phone number. Are the credentials correct?');
    }
    return [e164, { apiKey, apiSecret }];
  },
  async getStatusMsg(data: object): Promise<string> {
    return `Module not finished.`;
  },

  async processWebhook({ body }: IWebhookData): Promise<IWebhookResponse | null> {
    return null;
  },
  async sendMessage(data: object, from: string, to: string, body: string): Promise<void> {
    console.log(to, body);
  },
};


import * as express from 'express';

import { PhoneCall, PhoneCallEventArgs } from '../call';

import * as log from '../log';

export { PhoneCall, express };

export interface ILinkOpts {
  webhook: string;
};

export interface IWebhookHandlers {
  sendText(control: string, from: string, body: string): void;
  createCall(
    control: string,
    from: string,
  ): Promise<PhoneCall | null>;
  getConfig(control: string): Promise<object | null>;
}

export function getLogger(name: string) {
  return log.getLogger(`module/${name}`);
}

export interface IModule {
  friendly_name: string;

  tryLink(opts: ILinkOpts, ...args: string[]): Promise<[string, any]>;
  getStatusMsg(data: object): Promise<string>;

  registerWebhooks(app: express.Application, handlers: IWebhookHandlers): void;

  sendMessage(
    data: object,
    from: string,
    to: string,
    body: string,
  ): Promise<void>;

  sendCallInvite(
    data: object,
    call: PhoneCall,
    ...args: PhoneCallEventArgs['send_invite']
  ): Promise<void>;
  sendCallCandidates(
    data: object,
    call: PhoneCall,
    ...args: PhoneCallEventArgs['send_candidates']
  ): Promise<void>;
  sendCallAccept(
    data: object,
    call: PhoneCall,
    ...args: PhoneCallEventArgs['send_accept']
  ): Promise<void>;
  sendCallHangup(
    data: object,
    call: PhoneCall,
    ...args: PhoneCallEventArgs['send_hangup']
  ): Promise<void>;
};

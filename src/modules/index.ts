const Vonage = require('@vonage/server-sdk');

import { IModule, ILinkOpts, IWebhookData, IWebhookResponse } from './module';

import twilio from './twilio';
import vonage from './vonage'; // unfinished

const modules: { [key: string]: IModule } = { twilio };

export default modules;
export function getModule(name: string): IModule {
  return modules[name];
}
export function listModules(): string[] {
  return Object.keys(modules);
}

export { IModule, ILinkOpts, IWebhookData, IWebhookResponse };


export interface ILinkOpts {
  webhook: string;
};

export interface IWebhookData {
  body: Buffer;
};

export interface IWebhookResponse {
  type: 'text';
  from: string;
  text: string;
};

export interface IModule {
  friendly_name: string;

  tryLink(opts: ILinkOpts, ...args: string[]): Promise<[string, any]>;
  getStatusMsg(data: object): Promise<string>;

  processWebhook(data: IWebhookData): Promise<IWebhookResponse | null>;
  sendMessage(data: object, from: string, to: string, body: string): Promise<void>;
};


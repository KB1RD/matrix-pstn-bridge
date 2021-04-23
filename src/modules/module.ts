import { IResponseData } from '../httpserver';

export interface ILinkOpts {
  webhook: string;
};

export interface IWebhookData {
  body: Buffer;
  config: object;
};

interface ITextResponse {
  type: 'text';
  from: string;
  text: string;
};
interface ICreateCallResponse {
  type: 'create-call';
  from: string;
  remote_id: string;
  sdp: string;
  /**
   * Time in **ms** for invite expiry.
   */
  timeout: number;
}
interface ICallCandidatesResponse {
  type: 'call-candidates';
  from: string;
  remote_id: string;
  sdp: string[];
}

export type IWebhookResponse = ITextResponse | ICreateCallResponse | ICallCandidatesResponse;

export { IResponseData };

export interface IModule {
  friendly_name: string;

  tryLink(opts: ILinkOpts, ...args: string[]): Promise<[string, any]>;
  getStatusMsg(data: object): Promise<string>;

  processWebhook(
    data: IWebhookData,
    respond: (data?: IResponseData) => void,
  ): AsyncIterableIterator<IWebhookResponse>;

  sendMessage(data: object, from: string, to: string, body: string): Promise<void>;
  callAnswerRemote(rid: string, sdp: string): Promise<void>;
};


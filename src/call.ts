import * as Str from '@supercharge/strings';
import { TypedEventEmitter } from './util';

export enum CallState {
  CREATED = 0, INVITED = 1, ACCEPTED = 2, FAILED = 3, HUNGUP = 4,
}

type PhoneCallEvents = {
  send_invite(sdp: string): void;
  send_candidates(candidates_sdp: string[]): void;
  send_accept(sdp: string): void;
  send_hangup();
  statechange(new_state: CallState, old_state: CallState);
  ended();
}

export type PhoneCallEventArgs = {
  [key in keyof PhoneCallEvents]: Parameters<PhoneCallEvents[key]>;
};

export class PhoneCall extends TypedEventEmitter<PhoneCallEvents> {
  matrix_call_version = 0;
  private _state = CallState.CREATED;
  constructor(
    public readonly local: string,
    public readonly remote: string,
    public readonly from_matrix: boolean,
    public readonly matrix_id = Str.random(64)
  ) {
    super();
    this.on('send_invite', () => {
      this.state = CallState.INVITED;
    });
    this.on('send_accept', () => {
      this.state = CallState.ACCEPTED;
    });
    this.on('send_hangup', () => {
      this.state = CallState.HUNGUP;
    });
    this.on('statechange', (state: CallState) => {
      if (state === CallState.HUNGUP || state === CallState.FAILED) {
        this.emit('ended');
      }
    });
  }
  get state() {
    return this._state;
  }
  set state(state: CallState) {
    // Don't go backwards.
    if (this.state > state || this.state === CallState.HUNGUP) {
      return;
    }
    const oldstate = this._state;
    this._state = state;
    this.emit('statechange', state, oldstate);
  }
  get can_invite(): boolean {
    return this.state === CallState.CREATED;
  }
  get can_answer(): boolean {
    return this.state === CallState.INVITED;
  }
  get can_send_candidates(): boolean {
    return this.state >= CallState.INVITED && this.state < CallState.FAILED;
  }
  get can_reject(): boolean {
    // > This rejects the call on all devices, but if the calling device sees
    // an accept, it disregards the reject event and carries on.`
    return this.state < CallState.ACCEPTED;
  }
  // No point in asking if the call can be hung up; The answer is yes
}

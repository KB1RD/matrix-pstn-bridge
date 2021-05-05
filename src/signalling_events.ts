import ajv from './ajv';
import { JSONSchemaType } from 'ajv';

export interface IVoipEvent {
  call_id: string;
  version: number;
}
export namespace IVoipEvent {
  export const JSON: JSONSchemaType<IVoipEvent> = {
    $id: 'src/signalling_events.ts/IVoipEvent',
    type: 'object',
    properties: {
      call_id: { type: 'string' },
      version: { type: 'number' },
    },
    required: ['call_id', 'version'],
  };
  ajv.addSchema(JSON);
};

export interface IVoipInvite extends IVoipEvent {
  lifetime: number;
  offer: {
    sdp: string;
    type: 'offer';
  };
}
export namespace IVoipInvite {
  export const JSON: JSONSchemaType<IVoipInvite> = {
    $id: 'src/signalling_events.ts/IVoipInvite',
    type: 'object',
    properties: {
      call_id: { type: 'string' },
      version: { type: 'number' },
      lifetime: { type: 'number' },
      offer: {
        type: 'object',
        properties: {
          sdp: { type: 'string' },
          type: { type: 'string', enum: ['offer'] },
        },
        required: ['sdp', 'type'],
      },
    },
    required: ['call_id', 'version', 'lifetime', 'offer'],
  };
  ajv.addSchema(JSON);
  export const validate = ajv.compile(JSON);
};

export interface IVoipCandidates extends IVoipEvent {
  candidates: {
    candidate: string;
    sdpMLineIndex: number;
    sdpMid: string;
  }[];
}
export namespace IVoipCandidates {
  export const JSON: JSONSchemaType<IVoipCandidates> = {
    $id: 'src/signalling_events.ts/IVoipCandidates',
    type: 'object',
    properties: {
      call_id: { type: 'string' },
      version: { type: 'number' },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate: { type: 'string' },
            sdpMLineIndex: { type: 'number' },
            sdpMid: { type: 'string' },
          },
          required: ['candidate', 'sdpMLineIndex', 'sdpMid'],
        },
      }
    },
    required: ['call_id', 'version', 'candidates'],
  };
  ajv.addSchema(JSON);
  export const validate = ajv.compile(JSON);
};

export interface IVoipAnswer extends IVoipEvent {
  answer: {
    sdp: string;
    type: 'answer';
  };
}
export namespace IVoipAnswer {
  export const JSON: JSONSchemaType<IVoipAnswer> = {
    $id: 'src/signalling_events.ts/IVoipAnswer',
    type: 'object',
    properties: {
      call_id: { type: 'string' },
      version: { type: 'number' },
      answer: {
        type: 'object',
        properties: {
          sdp: { type: 'string' },
          type: { type: 'string', enum: ['answer'] },
        },
        required: ['sdp', 'type'],
      },
    },
    required: ['call_id', 'version', 'answer'],
  };
  ajv.addSchema(JSON);
  export const validate = ajv.compile(JSON);
};

export interface IVoipHangup extends IVoipEvent {}
export namespace IVoipHangup {
  export const JSON: JSONSchemaType<IVoipHangup> = Object.assign(
    {},
    IVoipEvent.JSON,
    { $id: 'src/signalling_events.ts/IVoipHangup' },
  );
  ajv.addSchema(JSON);
  export const validate = ajv.compile(JSON);
};

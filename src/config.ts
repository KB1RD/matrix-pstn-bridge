import * as YAML from 'yaml';
import * as fs from 'fs';
import { JSONSchemaType } from 'ajv';
import * as Str from '@supercharge/strings';
import { IAppserviceRegistration } from 'matrix-bot-sdk';

import ajv from './ajv';

type Complete<T> = T extends undefined ? never : T extends Object ? Required<{
  [P in keyof T]?: Complete<T[P]>;
}> : NonNullable<T>;

export type IRegexRuleAction = 'DENY' | 'USE' | 'FULL';
export type IRegexRules = { regex: string; action: IRegexRuleAction }[];
export namespace IRegexRules {
  export const JSON: JSONSchemaType<IRegexRules> = {
    $id: 'src/config.ts/IRegexRules',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        regex: { type: 'string' },
        action: { type: 'string', enum: ['DENY', 'USE', 'FULL'] },
      },
      required: ['regex', 'action'],
    },
  };
  ajv.addSchema(JSON);
};

export interface IConfigData {
  bridge: {
    port: number,
    bindAddress: string,
    homeserverName: string,
    homeserverUrl: string,
  };
  httpserver: {
    port: number;
    bindAddress: string;
    publicBaseURL: string;
  };
  permissions?: {
    modules?: string[],
    user_rules?: IRegexRules,
  };
  database: /*{ connString: string } |*/ { filename: string };
  logging?: { level?: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' };
};
export type ICompleteConfig = Complete<IConfigData>;
export namespace IConfigData {
  export const JSON: JSONSchemaType<IConfigData> = {
    $id: 'src/config.ts/IConfigData',
    type: 'object',
    properties: {
      bridge: {
        type: 'object',
        properties: {
          port: { type: 'number' },
          bindAddress: { type: 'string' },
          homeserverName: { type: 'string' },
          homeserverUrl: { type: 'string' },
        },
        required: ['port', 'bindAddress', 'homeserverName', 'homeserverUrl'],
      },
      httpserver: {
        type: 'object',
        properties: {
          port: { type: 'number' },
          bindAddress: { type: 'string' },
          publicBaseURL: { type: 'string' },
        },
        required: ['port', 'bindAddress', 'publicBaseURL'],
      },
      permissions: {
        type: 'object',
        properties: {
          modules: { type: 'array', items: { type: 'string' }, nullable: true },
          user_rules: { $ref: 'IRegexRules' },
        },
        required: [],
        nullable: true,
      },
      database: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
        },
        required: ['filename'],
      },
      logging: {
        type: 'object',
        properties: {
          level: {
            type: 'string', 
            enum: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'],
            nullable: true,
          },
        },
        required: [],
        nullable: true,
      },
    },
    required: ['bridge', 'database'],
  };
  ajv.addSchema(JSON);
};

export function loadConfig(path: string): ICompleteConfig {
  const config = YAML.parse(fs.readFileSync(path, 'utf8'));

  if (!ajv.validate('src/config.ts/IConfigData', config)) {
    throw ajv.errors && ajv.errors[0];
  }

  const pburl = config.httpserver.publicBaseURL;
  if (!pburl.startsWith('http://') && !pburl.startsWith('https://')) {
    throw new TypeError('Public base URL for the HTTP server must be HTTP or HTTPS');
  }
  if (!pburl.endsWith('/')) {
    config.httpserver.publicBaseURL += '/';
  }

  config.permissions = Object.assign(
    { modules: [], user_rules: [] },
    config.permissions || {}
  );
  config.logging = config.logging || {};
  config.logging.level = config.logging.level || 'INFO';

  return config as ICompleteConfig;
}

export function getUserAction(config: ICompleteConfig, mxid: string): IRegexRuleAction {
  for (const { regex, action } of config.permissions.user_rules) {
    if (mxid.match(regex)) {
      return action;
    }
  }
  return 'FULL';
}

export interface IRegOpts {
  id: string;
  url: string;
  prefix: string;
};

export function createRegistration(opts: IRegOpts): IAppserviceRegistration {
  const regex_safe_prefix = opts.prefix.replace('.', '\\.');
  return {
    id: opts.id,
    url: opts.url,
    as_token: Str.random(64),
    hs_token: Str.random(64),
    sender_localpart: opts.prefix,
    namespaces: {
      users: [{ exclusive: true, regex: '@' + regex_safe_prefix + '.*' }],
      aliases: [],
      rooms: [],
    },
    protocols: [],
    rate_limited: false,
  };
}

export interface IRegTokens {
  as_token: string;
  hs_token: string;
}

export function loadRegTokens(path: string): IRegTokens {
  const config = YAML.parse(fs.readFileSync(path, 'utf8'));
  if (
    typeof config !== 'object' ||
    typeof config.as_token !== 'string' ||
    typeof config.hs_token !== 'string'
  ) {
    throw new TypeError('Invalid registration file');
  }
  return config as IRegTokens;
}


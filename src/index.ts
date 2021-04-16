import * as commandLineArgs from 'command-line-args';
import * as commandLineUsage from 'command-line-usage';

import * as fs from 'fs';
import * as YAML from 'yaml';
import { SimpleRetryJoinStrategy, LogService, LogLevel } from 'matrix-bot-sdk';

import { loadConfig, createRegistration, loadRegTokens } from './config';
import { Bridge } from './bridge';
import { SqliteBridgeDatabase } from './database';
import { BridgeHTTPServer } from './httpserver';

const commandOptions = [
  { name: 'register', alias: 'r', type: Boolean },
  { name: 'registration-file', alias: 'f', type: String },
  { name: 'config', alias: 'c', type: String },
  { name: 'help', alias: 'h', type: Boolean },
];
const options = Object.assign({
  register: false,
  'registration-file': 'registration.yaml',
  config: 'config.yaml',
  help: false,
}, commandLineArgs(commandOptions));

// if we asked for help, just display the help and exit
if (options.help) {
  // tslint:disable-next-line:no-console
  console.log(commandLineUsage([
    {
      header: "Matrix PSTN Bridge",
      content: "A Matrix Puppet bridge for the public telephone network that supports a number of VoIP providers (Twillo, Vonage, etc.)",
    },
    {
      header: "Options",
      optionList: commandOptions,
    },
  ]));
  process.exit(0);
}

const config = loadConfig(options.config);
const prefix = '_pstn_';

// The logging level is already validated by Ajv
LogService.setLevel(LogLevel[config.logging.level]);

const registration = createRegistration({
  prefix,
  id: "pstn-puppet",
  url: `http://${config.bridge.bindAddress}:${config.bridge.port}`,
});

if (options.register) {
  try {
    fs.writeFileSync(
      options['registration-file'],
      YAML.stringify(registration)
    );
  } catch (err) {
    // tslint:disable-next-line:no-console
    console.log("Couldn't generate registration file:", err);
    process.exit(1);
  }
  process.exit(0);
}

Object.assign(registration, loadRegTokens(options['registration-file']));

const storage = new SqliteBridgeDatabase({ file: config.database.filename });

const httpserver = new BridgeHTTPServer(config, storage);

const bridge = new Bridge({
  ...config.bridge,
  registration,
  joinStrategy: new SimpleRetryJoinStrategy(),
  prefix,
  storage,
  httpserver,
  config,
});

bridge.begin();


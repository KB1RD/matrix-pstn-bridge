import * as log from 'loglevel';
import * as chalk from 'chalk';
import * as prefix from 'loglevel-plugin-prefix';

import { LogService } from 'matrix-bot-sdk';

const colors = {
  TRACE: chalk.magenta,
  DEBUG: chalk.cyan,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red,
}
prefix.reg(log)
function setupLoggerPrefix(logger: log.Logger): void {
  prefix.apply(logger, {
    format(level, name, timestamp) {
      return `${chalk.gray(`[${timestamp}]`)} ${colors[level.toUpperCase()](level)} ${chalk.green(`${name}:`)}`;
    }
  });
}
setupLoggerPrefix(log);

export { log };

const setup_loggers = new WeakSet<log.Logger>();
export function getLogger(name: string): log.Logger {
  const lg = log.getLogger(name);
  if (!setup_loggers.has(lg)) {
    setupLoggerPrefix(lg);
  }
  return lg;
}

LogService.setLogger({
  info(module: string, ...args: any[]) {
    getLogger(`matrix-bot-sdk/${module}`).info(...args);
  },
  warn(module: string, ...args: any[]) {
    getLogger(`matrix-bot-sdk/${module}`).warn(...args);
  },
  error(module: string, ...args: any[]) {
    getLogger(`matrix-bot-sdk/${module}`).error(...args);
  },
  debug(module: string, ...args: any[]) {
    getLogger(`matrix-bot-sdk/${module}`).debug(...args);
  },
  trace(module: string, ...args: any[]) {
    getLogger(`matrix-bot-sdk/${module}`).trace(...args);
  },
});

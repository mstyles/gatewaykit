type Fields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

const line = (level: string, msg: string, fields?: Fields) =>
  JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });

/** Structured JSON lines: easy to grep locally, easy to ship to a log pipeline. */
export const consoleLogger: Logger = {
  info: (msg, fields) => console.log(line('info', msg, fields)),
  warn: (msg, fields) => console.warn(line('warn', msg, fields)),
  error: (msg, fields) => console.error(line('error', msg, fields)),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

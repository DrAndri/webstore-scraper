import { inspect } from 'node:util';
import {
  Logger,
  format,
  config,
  transports,
  createLogger as createWinstonLogger
} from 'winston';
import LokiTransport from 'winston-loki';
import { log as crawleeLog, LogLevel } from 'crawlee';

const { combine, colorize, splat, timestamp, errors, printf } = format;

const LOKI_URL = process.env.LOKI_URL;
const ENABLE_SCRAPER_LOGGING =
  process.env.ENABLE_SCRAPER_LOGGING === 'true' ? true : false;
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

// Metadata that is not part of the line itself is appended to it, e.g. the
// statistics crawlee logs or the fields of a SqlError
const appFormat = printf(
  ({ timestamp, level, label, message, stack, ...meta }) => {
    const prefix = typeof label === 'string' ? `[${label}] ` : '';
    // Object.entries skips winston's symbol keys
    const fields = Object.entries(meta).filter(([, v]) => v !== undefined);
    const extra = fields.length
      ? ` ${inspect(Object.fromEntries(fields), { depth: 4, breakLength: Infinity })}`
      : '';
    const trace = typeof stack === 'string' ? `\n${stack}` : '';
    return `${String(timestamp)} [${level}]: ${prefix}${String(message)}${extra}${trace}`;
  }
);

// The log of the scraper itself, modules add a label with logger.child()
export const logger = createWinstonLogger({
  levels: config.npm.levels,
  level: LOG_LEVEL,
  // No splat(), it would copy the message of an object passed as meta over
  // the log message, the messages are template strings instead
  format: errors({ stack: true }),
  transports: [
    new transports.Console({
      format: combine(colorize(), timestamp(), appFormat)
    }),
    ...(LOKI_URL
      ? [
          new LokiTransport({
            host: LOKI_URL,
            labels: { app: 'webstore-scraper' },
            format: format.json(),
            json: true,
            // Seconds, the admin interface shows the log live
            interval: 5
          })
        ]
      : [])
  ]
});

const crawleeLogger = logger.child({ label: 'crawlee' });
const toWinstonLevel = (level: LogLevel) => {
  if (level <= LogLevel.ERROR) return 'error';
  if (level <= LogLevel.WARNING) return 'warn';
  if (level === LogLevel.INFO) return 'info';
  return 'debug';
};

// Sends crawlee's log to winston. The child logs crawlee creates, also the ones
// its modules create on import, share the default logger instance, so its
// output is replaced instead of passing a new logger to log.setOptions()
crawleeLog.getOptions().logger._log = (
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
  exception?: unknown,
  opts?: { prefix?: string | null }
) => {
  const prefix = opts?.prefix ? `${opts.prefix}: ` : '';
  // winston appends the message of the meta and shows its stack
  const error = exception as { message?: string; stack?: string } | undefined;
  crawleeLogger.log(toWinstonLevel(level), `${prefix}${message}`, {
    ...data,
    message: error?.message,
    stack: error?.stack
  });
};
if (['debug', 'silly'].includes(LOG_LEVEL))
  crawleeLog.setLevel(LogLevel.DEBUG);

// The log of a scan, labelled with the page it is about. jobId is the id of
// the scrapeJobs row, so the admin interface can show the log of each scan.
export const createLogger = (
  label: string,
  storeName: string,
  jobId: number
) => {
  const transportsArray = [];
  if (LOKI_URL) {
    transportsArray.push(
      new LokiTransport({
        host: LOKI_URL,
        labels: {
          store: storeName,
          jobId,
          page: label
        },
        format: combine(splat(), errors({ stack: true }), format.json()),
        json: true,
        level: 'debug',
        interval: 5,
        silent: !ENABLE_SCRAPER_LOGGING
      })
    );
  } else {
    const customFormat = printf(({ timestamp, level, message, stack }) => {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      return `${timestamp} [${level}]: [${label}] ${stack ?? message}`;
    });
    transportsArray.push(
      new transports.Console({
        level: 'warn',
        format: combine(
          colorize(),
          splat(),
          timestamp(),
          errors({ stack: true }),
          customFormat
        ),
        silent: !ENABLE_SCRAPER_LOGGING
      })
    );
  }
  return new Logger({
    levels: config.npm.levels,
    transports: transportsArray
  });
};

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
import type { Store } from './types/db-types.js';

const { combine, colorize, splat, timestamp, errors, printf } = format;

// winston-loki puts a batch Loki rejected back in the queue and retries it with
// the next one, without a limit. When Loki keeps rejecting (it is down, or a
// limit like max streams or ingestion rate is hit) the queue grows until the
// heap runs out, so a failed batch is dropped and the failure is reported to
// the console, as logging it to Loki would fail the same way.
// Without a timeout the push used the 5 second idle timeout of Node's default
// agent, which a busy Loki can exceed.
const lokiSendOptions = {
  timeout: 30000,
  clearOnError: true,
  onConnectionError: (error: unknown) =>
    console.error('Sending logs to Loki failed, the batch was dropped', error)
};

const LOKI_URL = process.env.LOKI_URL;
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

// The log of the scraper itself, modules add a label with logger.child().
// It goes to Loki when LOKI_URL is set, otherwise to the console.
export const logger = createWinstonLogger({
  levels: config.npm.levels,
  level: LOG_LEVEL,
  // No splat(), it would copy the message of an object passed as meta over
  // the log message, the messages are template strings instead
  format: errors({ stack: true }),
  transports: [
    LOKI_URL
      ? new LokiTransport({
          host: LOKI_URL,
          labels: { app: 'webstore-scraper' },
          format: format.json(),
          json: true,
          // Seconds, the admin interface shows the log live
          interval: 5,
          ...lokiSendOptions
        })
      : new transports.Console({
          format: combine(colorize(), timestamp(), appFormat)
        })
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
if (['debug', 'silly'].includes(LOG_LEVEL)) crawleeLog.setLevel(LogLevel.DEBUG);

// Each distinct set of labels is a Loki stream, which the ingester keeps until
// it has been idle for chunk_idle_period (30 minutes by default), so a label
// for each page hit the max streams limit on large stores. The page is a field
// of the entry instead, winston-loki sends it as structured metadata, which is
// searched with {jobId="1"} | page="https://..."
interface ScanLabels {
  store: string;
  jobId: number;
}

// winston-loki sends the labels of an entry as the labels of its stream, the
// line is the JSON of the rest of the entry
const jsonLine = format.json({});
const lineWithoutLabels = format((info) => {
  const line = { ...info };
  delete line.labels;
  const formatted = jsonLine.transform(line, jsonLine.options);
  if (typeof formatted === 'object')
    info[Symbol.for('message')] = formatted[Symbol.for('message')];
  return info;
});

// All the scans log through this one transport. winston-loki registers an exit
// hook for every transport that is never removed, so a transport for each page
// kept every one of them in memory.
const scanLogger = new Logger({
  levels: config.npm.levels,
  transports: [
    LOKI_URL
      ? new LokiTransport({
          host: LOKI_URL,
          // Without labels the stream would get a job label
          labels: {},
          format: combine(
            splat(),
            errors({ stack: true }),
            lineWithoutLabels()
          ),
          json: true,
          level: 'debug',
          interval: 5,
          ...lokiSendOptions
        })
      : new transports.Console({
          level: 'warn',
          format: combine(
            colorize(),
            splat(),
            timestamp(),
            errors({ stack: true }),
            printf(({ timestamp, level, message, stack, page }) => {
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              return `${timestamp} [${level}]: [${page}] ${stack ?? message}`;
            })
          )
        })
  ]
});

// Stores with logging turned off get this logger, it drops every line
const silentLogger = new Logger({ silent: true });

// The log of a scan, labelled with the page it is about. jobId is the id of
// the scrapeJobs row, so the admin interface can show the log of each scan.
// Pages are only logged when logging is turned on for the store in the admin
// interface (stores.loggingEnabled).
// The child shares the transport of scanLogger, it must not be closed.
export const createLogger = (
  label: string,
  store: Pick<Store, 'name' | 'loggingEnabled'>,
  jobId: number
): Logger =>
  store.loggingEnabled
    ? scanLogger.child({
        labels: { store: store.name, jobId } satisfies ScanLabels,
        page: label
      })
    : silentLogger;

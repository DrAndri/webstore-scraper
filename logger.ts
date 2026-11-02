import { Logger, format, config, transports } from 'winston';
import LokiTransport from 'winston-loki';

const { combine, colorize, splat, timestamp, errors, printf } = format;

const LOKI_URL = process.env.LOKI_URL;
const ENABLE_SCRAPER_LOGGING =
  process.env.ENABLE_SCRAPER_LOGGING === 'true' ? true : false;

export const createLogger = (
  label: string,
  storeName: string,
  currentDate: Date
) => {
  const transportsArray = [];
  if (LOKI_URL) {
    transportsArray.push(
      new LokiTransport({
        host: LOKI_URL,
        labels: {
          store: storeName,
          batch: currentDate,
          page: label
        },
        format: combine(splat(), errors({ stack: true }), format.json()),
        json: true,
        level: 'debug',
        interval: 30,
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

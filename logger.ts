import { Logger, format, config, transports } from 'winston';
import LokiTransport from 'winston-loki';

const { combine, colorize, splat, timestamp, errors, printf } = format;

const LOKI_URL = process.env.LOKI_URL;

export const createStoreLogger = (label: string) => {
  const customFormat = printf(({ timestamp, level, message, stack }) => {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    return `${timestamp} [${level}]: [${label}] ${stack ?? message}`;
  });

  return new Logger({
    levels: config.npm.levels,
    transports: [
      new transports.Console({
        level: 'info',
        format: combine(
          colorize(),
          splat(),
          timestamp(),
          errors({ stack: true }),
          customFormat
        )
      })
    ]
  });
};

export const createProductLogger = (
  label: string,
  storeName: string,
  batchTimestamp: number
) => {
  const transportsArray = [];
  if (LOKI_URL) {
    transportsArray.push(
      new LokiTransport({
        host: LOKI_URL,
        labels: {
          store: storeName,
          batch: batchTimestamp.toString(),
          page: label.substring(0, 100)
        },
        format: combine(splat(), errors({ stack: true }), format.json()),
        json: true,
        level: 'debug'
      })
    );
  }
  return new Logger({
    levels: config.npm.levels,
    transports: transportsArray
  });
};

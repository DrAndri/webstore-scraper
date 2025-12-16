import { Logger, format, config, transports } from 'winston';
import filenamify from 'filenamify';

const { combine, colorize, splat, timestamp, errors, printf } = format;

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
  const customFormat = printf(({ timestamp, level, message, stack }) => {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    return `${timestamp} [${level}]: [${label}] ${stack ?? message}`;
  });

  const safeLabel = filenamify(label.substring(0, 100), { replacement: '' });

  return new Logger({
    levels: config.npm.levels,
    transports: [
      new transports.File({
        filename: `/logs/${storeName}/${batchTimestamp}/${safeLabel}.log`,
        level: 'debug',
        format: combine(
          splat(),
          timestamp(),
          errors({ stack: true }),
          customFormat
        )
      })
    ]
  });
};

import { Logger, format, config, transports } from 'winston';

const { combine, colorize, splat, timestamp, errors, printf } = format;
export const createLogger = (
  label: string,
  storeName: string,
  batchTimestamp: number
) => {
  const customFormat = printf(({ timestamp, level, message, stack }) => {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    return `${timestamp} [${level}]: [${label}] ${stack ?? message}`;
  });

  return new Logger({
    levels: config.npm.levels,
    transports: [
      new transports.Console({
        level: 'error',
        format: combine(
          colorize(),
          splat(),
          timestamp(),
          errors({ stack: true }),
          customFormat
        )
      }),
      new transports.File({
        filename: `/logs/${storeName}/${batchTimestamp}/${label}.log`,
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

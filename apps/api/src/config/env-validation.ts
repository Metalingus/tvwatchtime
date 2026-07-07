import * as Joi from 'joi';

export const envValidation = {
  allowUnknown: true,
  abortEarly: false,
  validationSchema: Joi.object({
    NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
    LOG_LEVEL: Joi.string()
      .valid('verbose', 'debug', 'log', 'warn', 'error')
      .default('log'),
    API_PORT: Joi.number().default(4000),
    DATABASE_URL: Joi.string().required(),
    REDIS_URL: Joi.string().required(),
    JWT_SECRET: Joi.string().min(16).required(),
    JWT_ACCESS_TTL: Joi.string().default('15m'),
    JWT_REFRESH_TTL: Joi.string().default('30d'),
  }),
};

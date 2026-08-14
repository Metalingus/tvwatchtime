import * as Joi from 'joi';

export const envValidation = {
  allowUnknown: true,
  abortEarly: false,
  validationSchema: Joi.object({
    NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
    LOG_LEVEL: Joi.string().valid('verbose', 'debug', 'log', 'warn', 'error').default('log'),
    API_PORT: Joi.number().default(4000),
    DATABASE_URL: Joi.string().optional().allow(''),
    REDIS_URL: Joi.string().optional().allow(''),
    JWT_SECRET: Joi.string().min(16).required(),
    JWT_ACCESS_TTL: Joi.string().default('15m'),
    JWT_REFRESH_TTL: Joi.string().default('30d'),
    APPLE_CLIENT_ID: Joi.string().optional().allow(''),
    APPLE_TEAM_ID: Joi.string().optional().allow(''),
    APPLE_KEY_ID: Joi.string().optional().allow(''),
    APPLE_PRIVATE_KEY: Joi.string().optional().allow(''),
    APPLE_PRIVATE_KEY_PATH: Joi.string().optional().allow(''),
    SIMKL_CLIENT_ID: Joi.string().optional().allow(''),
    SIMKL_APP_NAME: Joi.string().trim().min(1).optional(),
    SIMKL_APP_VERSION: Joi.string().trim().min(1).optional(),
    ALLOW_PRIVATE_INTEGRATION_URLS: Joi.boolean().optional(),
    INTEGRATION_SYNC_BATCH_SIZE: Joi.number().integer().min(1).max(250).optional(),
    INTEGRATION_SYNC_STALE_HOURS: Joi.number().min(1).max(168).optional(),
  }),
};

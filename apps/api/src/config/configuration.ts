export default () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'log',
  api: {
    port: parseInt(process.env.API_PORT || '4000', 10),
    baseUrl: process.env.API_BASE_URL || 'http://localhost:4000',
  },
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
  database: { url: process.env.DATABASE_URL },
  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  },
  auth: {
    google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
    apple: {
      clientId: process.env.APPLE_CLIENT_ID,
      teamId: process.env.APPLE_TEAM_ID,
      keyId: process.env.APPLE_KEY_ID,
      privateKeyPath: process.env.APPLE_PRIVATE_KEY_PATH,
    },
    facebook: { appId: process.env.FACEBOOK_APP_ID, appSecret: process.env.FACEBOOK_APP_SECRET },
    bootstrapSuperAdminEmail: process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL,
  },
  push: {
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN,
    firebase: {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
  },
  storage: {
    s3Endpoint: process.env.S3_ENDPOINT,
    s3Region: process.env.S3_REGION || 'us-east-1',
    s3Bucket: process.env.S3_BUCKET || 'tvwatch-media',
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    s3PublicBaseUrl: process.env.S3_PUBLIC_BASE_URL,
  },
  metadata: {
    tmdbApiKey: process.env.TMDB_API_KEY,
    tmdbLanguage: process.env.TMDB_LANGUAGE || 'en-US',
    tmdbRps: Number(process.env.TMDB_RPS || 40),
    tvmazeEnabled: process.env.TVMAZE_ENABLED !== 'false',
    tvmazeApiKey: process.env.TVMAZE_API_KEY,
    pushMode: process.env.PUSH_MODE || 'expo', // expo | relay | none
    relayUrl: process.env.PUSH_RELAY_URL, // e.g. https://api.tvwatchtime.org/api
    // Season rating chart: false = app users' ratings only (unrated = 0);
    // true = fall back to provider (TMDb) ratings for episodes with no user votes.
    useApiRatingsForChart: process.env.USE_API_FOR_EPISODES_CHART === 'true',
    trakt: {
      clientId: process.env.TRAKT_CLIENT_ID,
      clientSecret: process.env.TRAKT_CLIENT_SECRET,
    },
  },
  jobs: {
    metadataRefreshCron: process.env.METADATA_REFRESH_CRON || '0 3 * * *',
    notificationsDispatchCron: process.env.NOTIFICATIONS_DISPATCH_CRON || '*/5 * * * *',
  },
  imports: {
    dailyLimit: Number(process.env.IMPORT_DAILY_LIMIT || 3),
  },
  commentImages: {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModerationModel: process.env.OPENAI_MODERATION_MODEL || 'omni-moderation-latest',
    s3Region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
    s3Bucket: process.env.S3_BUCKET_COMMENT_IMAGES || process.env.S3_BUCKET || 'tvwatch-comment-images',
    s3TempBucket: process.env.S3_BUCKET_TEMP_UPLOADS || 'tvwatch-temp-uploads',
    s3Endpoint: process.env.S3_ENDPOINT,
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
    encryptionMasterKey: process.env.ENCRYPTION_MASTER_KEY || 'dev-master-key-change-in-prod-32bytes!',
    maxUploadMb: Number(process.env.MAX_COMMENT_IMAGE_UPLOAD_MB || 5),
    maxHardLimitMb: Number(process.env.MAX_COMMENT_IMAGE_HARD_LIMIT_MB || 20),
    maxPixels: Number(process.env.MAX_COMMENT_IMAGE_PIXELS || 36000000),
    maxLongEdge: Number(process.env.COMMENT_IMAGE_MAX_LONG_EDGE || 1600),
    webpQuality: Number(process.env.COMMENT_IMAGE_WEBP_QUALITY || 95),
    thumbMaxLongEdge: Number(process.env.COMMENT_THUMBNAIL_MAX_LONG_EDGE || 480),
    thumbWebpQuality: Number(process.env.COMMENT_THUMBNAIL_WEBP_QUALITY || 85),
    uploadsPerUserPerDay: Number(process.env.COMMENT_IMAGE_UPLOADS_PER_USER_PER_DAY || 20),
    workerConcurrency: Number(process.env.COMMENT_IMAGE_WORKER_CONCURRENCY || 2),
  },
  notifications: {
    maxPushPerUserPerDay: Number(process.env.MAX_PUSH_NOTIFICATIONS_PER_USER_PER_DAY || 3),
  },
  pushRelay: {
    rateLimit: Number(process.env.PUSH_RELAY_RATE_LIMIT || 10),
    rateWindowMinutes: Number(process.env.PUSH_RELAY_RATE_WINDOW_MINUTES || 10),
    enabled: process.env.PUSH_RELAY_ENABLED !== 'false',
  },
});

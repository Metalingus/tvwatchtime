const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.platformExts = ['web', 'native', 'ios', 'android'];
config.resolver.sourceExts.push('web');

module.exports = config;

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(process.env.RIFUGIO_ROOT || path.join(__dirname, '..', '..', '..'));
const DATA_DIR = path.resolve(process.env.RIFUGIO_DATA_DIR || path.join(ROOT_DIR, 'data'));
const PRIVATE_DIR = path.resolve(process.env.RIFUGIO_PRIVATE_DIR || path.join(ROOT_DIR, 'private'));
const PROFILE_FILE = path.resolve(process.env.RIFUGIO_PROFILE_FILE || path.join(PRIVATE_DIR, 'profile.json'));
const FEATURES_FILE = path.resolve(process.env.RIFUGIO_FEATURES_FILE || path.join(PRIVATE_DIR, 'features.json'));

function readJson(file, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

const profile = readJson(PROFILE_FILE, {});
const user = profile.user || {};
const companion = profile.companion || {};
const relationship = profile.relationship || {};
const pet = profile.pet || {};

const USER_NAME = String(process.env.RIFUGIO_USER_NAME || user.displayName || user.name || 'User');
const COMPANION_NAME = String(process.env.RIFUGIO_COMPANION_NAME || companion.displayName || companion.name || 'Companion');
const HOME_NAME = String(process.env.RIFUGIO_HOME_NAME || relationship.homeName || 'Our Rifugio');
const PUBLIC_URL = String(process.env.RIFUGIO_PUBLIC_URL || 'http://localhost:3457').replace(/\/+$/, '');

function readPrivateText(fileName, max = 50000) {
  const requested = String(fileName || '').trim();
  if (!requested) return '';
  const candidate = path.resolve(PRIVATE_DIR, requested);
  if (candidate !== PRIVATE_DIR && !candidate.startsWith(PRIVATE_DIR + path.sep)) return '';
  try { return fs.readFileSync(candidate, 'utf8').slice(0, max).trim(); } catch (_) { return ''; }
}
const PERSONA_TEXT = readPrivateText(process.env.RIFUGIO_PERSONA_FILE || companion.personaFile || 'persona.md');
const PET_PROFILE = Object.freeze({
  name: String(pet.name || 'Clawd'),
  birthday: String(pet.birthday || ''),
  species: String(pet.species || 'pixel crab'),
  personality: String(pet.personality || ''),
  bio: String(pet.bio || ''),
});

const configuredFeatures = readJson(FEATURES_FILE, {});
const features = Object.freeze({
  memory: configuredFeatures.memory !== false,
  chat: configuredFeatures.chat !== false,
  mcp: configuredFeatures.mcp !== false,
  health: envFlag('RIFUGIO_ENABLE_HEALTH', configuredFeatures.health === true),
  radio: envFlag('RIFUGIO_ENABLE_RADIO', configuredFeatures.radio === true),
  image: envFlag('RIFUGIO_ENABLE_IMAGE', configuredFeatures.image === true),
  voice: envFlag('RIFUGIO_ENABLE_VOICE', configuredFeatures.voice === true),
  toy: envFlag('RIFUGIO_ENABLE_TOY', configuredFeatures.toy === true),
  cliBridge: envFlag('RIFUGIO_ENABLE_CLI_BRIDGE', configuredFeatures.cliBridge === true),
});

function dataPath(...parts) { return path.join(DATA_DIR, ...parts); }
function privatePath(...parts) { return path.join(PRIVATE_DIR, ...parts); }

function ensureRuntimeDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
}

function publicConfig() {
  return {
    profile: {
      userName: USER_NAME,
      companionName: COMPANION_NAME,
      homeName: HOME_NAME,
      preferredNickname: String(user.preferredNickname || ''),
      timezone: String(user.timezone || 'UTC'),
      coupleTitle: String(relationship.coupleTitle || ''),
      relationshipStart: String(relationship.startedAt || ''),
      pet: PET_PROFILE,
    },
    features,
  };
}

module.exports = {
  ROOT_DIR, DATA_DIR, PRIVATE_DIR, PROFILE_FILE, FEATURES_FILE,
  USER_NAME, COMPANION_NAME, HOME_NAME, PUBLIC_URL, PERSONA_TEXT, PET_PROFILE,
  profile, features, dataPath, privatePath, ensureRuntimeDirs, publicConfig,
};

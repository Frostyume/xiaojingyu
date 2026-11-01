// Trusted operator configuration only. Never populate these values from a tool
// argument, retrieved content, or an untrusted message. Values are not logged.
import {isAbsolute} from 'node:path';

export function configurationError(name, missing = false) {
  return Object.assign(Error((missing ? 'Missing trusted installation setting: ' : 'Invalid trusted installation setting: ') + name),
    {code: missing ? 'XI_MISSING_CONFIG' : 'XI_INVALID_CONFIG', setting: name});
}
export function installationPath(name, value = process.env[name]) {
  if (value === undefined || value === null || value === '') throw configurationError(name, true);
  if (typeof value !== 'string' || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value) || !isAbsolute(value)) throw configurationError(name);
  return value;
}
export function trustedSelfId(value = process.env.XI_SELF_ID) {
  if (value === undefined || value === null || value === '') throw configurationError('XI_SELF_ID', true);
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw configurationError('XI_SELF_ID');
  return String(value);
}
export function trustedForumIds(value = process.env.XI_TIEBA_CLAW_FORUM_IDS) {
  if (value === undefined || value === null || value === '') return Object.freeze([]);
  const values = typeof value === 'string' ? value.split(',').map(v => v.trim()) : value;
  if (!Array.isArray(values) || !values.length || values.length > 32 || values.some(v => typeof v !== 'string' || !/^[1-9]\d{0,19}$/.test(v)) || new Set(values).size !== values.length) throw configurationError('XI_TIEBA_CLAW_FORUM_IDS');
  return Object.freeze([...values]);
}

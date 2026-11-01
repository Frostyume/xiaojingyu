// Private decoder installation metadata; the adjacent JSON is only a template.
// Hashes identify reviewed binaries, not proof of native/AppContainer execution.
import {readFileSync,lstatSync} from 'node:fs';
import {installationPath,configurationError} from './installation-config.mjs';
export function readVideoDecoderConfig(configPath = process.env.XI_VIDEO_DECODER_CONFIG) {
  const path = installationPath('XI_VIDEO_DECODER_CONFIG', configPath), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 32768) throw configurationError('XI_VIDEO_DECODER_CONFIG');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || value.template === true || !/^[a-f0-9]{64}$/.test(value.binary_sha256) || /^0{64}$/.test(value.binary_sha256)) throw configurationError('XI_VIDEO_DECODER_CONFIG');
  installationPath('XI_VIDEO_DECODER_CONFIG.binary', value.binary);
  return Object.freeze({binary:value.binary,binary_sha256:value.binary_sha256,version:value.version});
}

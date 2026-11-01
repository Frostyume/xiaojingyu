import crypto from 'node:crypto';

/** Pure adapter for a private, operator-approved card and identity configuration.
 * The caller must load these inputs from private storage. No default persona,
 * relationship, account identity, or card content is distributed with source.
 */
export function buildXiProfile(card, sourceName, { roleName, xiIdentity, wakeKeywords } = {}) {
  if (typeof card !== 'string' || !card.trim() || typeof sourceName !== 'string' || !sourceName.trim() ||
      typeof roleName !== 'string' || !roleName.trim() || /[\\/\x00-\x1f]/.test(roleName))
    throw new Error('PRIVATE_APPROVED_CARD_AND_ROLE_REQUIRED');
  if (!xiIdentity || xiIdentity.enabled !== true || xiIdentity.roleName !== roleName ||
      typeof xiIdentity.kernel !== 'string' || !xiIdentity.kernel.trim() ||
      !xiIdentity.relationshipPresentationByUserId || typeof xiIdentity.relationshipPresentationByUserId !== 'object' ||
      Array.isArray(xiIdentity.relationshipPresentationByUserId)) throw new Error('PRIVATE_IDENTITY_CONFIGURATION_REQUIRED');
  for (const [id, relation] of Object.entries(xiIdentity.relationshipPresentationByUserId)) {
    if (!/^\d{5,15}$/.test(id) || !relation ||
        !['address', 'label', 'tone'].every(key => typeof relation[key] === 'string' && relation[key].trim()))
      throw new Error('PRIVATE_RELATIONSHIP_MAPPING_REQUIRED');
  }
  if (!Array.isArray(wakeKeywords) || !wakeKeywords.length || wakeKeywords.some(value => typeof value !== 'string' || !value.trim()))
    throw new Error('PRIVATE_WAKE_KEYWORDS_REQUIRED');
  return { roleName, card, xiIdentity: structuredClone(xiIdentity), wakeKeywords: [...new Set(wakeKeywords)],
    source: { name: sourceName, sha256: crypto.createHash('sha256').update(card).digest('hex'), bytes: Buffer.byteLength(card) } };
}

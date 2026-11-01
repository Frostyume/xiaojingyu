/** Current QQ friends can initiate a private conversation without a manually
 * maintained ID list. This reads the existing bridge, never adds a friend. */
export function createOwnedFriendAdmission({url, token, botId, enabled = true, authorize,
  fetcher = globalThis.fetch, clock = () => Date.now(), ttlMs = 300000} = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
      typeof token !== 'string' || !token || typeof authorize !== 'function') throw new Error('Explicit owned friend connection required');
  let cached = new Set(), freshUntil = 0, nextAttempt = 0, pending;
  async function update() {
    const response = await fetcher(new URL('/get_friend_list',endpoint), {method:'POST', redirect:'error',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('Friend roster unavailable');
    const payload = await response.json();
    if (payload.retcode !== 0 || !Array.isArray(payload.data) || payload.data.length > 10000) throw new Error('Friend roster response invalid');
    const ids = payload.data.map(entry=>String(entry.user_id ?? ''));
    if (!ids.every(id=>/^\d{5,15}$/.test(id))) throw new Error('Friend roster identity invalid');
    cached = new Set(ids.filter(id=>id!==String(botId))); freshUntil = clock()+ttlMs;
  }
  return async function friendAdmission(event) {
    if (!enabled || event?.message_type !== 'private' || !/^\d{5,15}$/.test(String(event.user_id)) || await authorize() !== true) return false;
    if (clock() >= freshUntil) {
      if (clock() < nextAttempt) return false;
      if (!pending) pending = update().catch(()=>{nextAttempt=clock()+30000;}).finally(()=>{pending=undefined;});
      await pending;
    }
    return clock() < freshUntil && cached.has(String(event.user_id));
  };
}

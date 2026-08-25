/* Probe which media-post sources the Grok API accepts — paste into the DevTools console
   on https://grok.com/imagine. Read-only: it only issues list queries (limit 5) and prints
   which enum values are accepted and what date range each returns.

   Why: grokSearch.js indexes MEDIA_POST_SOURCE_LIKED only. If your own recent generations
   are not liked, they are not in that feed. This finds out whether another source exposes
   them, so the script can be taught to index it. */
(async () => {
  const CANDIDATES = [
    'MEDIA_POST_SOURCE_LIKED',
    'MEDIA_POST_SOURCE_UNSPECIFIED',
    'MEDIA_POST_SOURCE_OWN',
    'MEDIA_POST_SOURCE_SELF',
    'MEDIA_POST_SOURCE_MINE',
    'MEDIA_POST_SOURCE_USER',
    'MEDIA_POST_SOURCE_CREATED',
    'MEDIA_POST_SOURCE_GENERATED',
    'MEDIA_POST_SOURCE_GENERATION',
    'MEDIA_POST_SOURCE_HISTORY',
    'MEDIA_POST_SOURCE_SAVED',
    'MEDIA_POST_SOURCE_BOOKMARKED',
    'MEDIA_POST_SOURCE_ALL',
    'MEDIA_POST_SOURCE_PUBLIC',
    'MEDIA_POST_SOURCE_PROFILE',
  ];

  const query = async filter => {
    const body = { limit: 5 };
    if (filter !== undefined) body.filter = filter;
    let res;
    try {
      res = await fetch('https://grok.com/rest/media/post/list', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) { return { error: String(e) }; }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!data) return { status: res.status, body: text.slice(0, 140) };
    const posts = data.posts || [];
    const dates = posts.map(p => p.createTime || p.createdAt || p.create_time || '').filter(Boolean).sort();
    return {
      status: res.status,
      posts: posts.length,
      newest: dates[dates.length - 1] || null,
      oldest: dates[0] || null,
      hasCursor: Boolean(data.nextCursor),
      sampleId: posts[0]?.id || null,
    };
  };

  const results = {};
  console.log('%cProbing media-post sources…', 'font-weight:bold');

  results['(no filter key at all)'] = await query(undefined);
  results['{} empty filter'] = await query({});
  results['{safeForWork:false}'] = await query({ safeForWork: false });

  for (const source of CANDIDATES) {
    results[source] = await query({ source, safeForWork: false });
    await new Promise(r => setTimeout(r, 120));
  }

  const accepted = Object.entries(results)
    .filter(([, v]) => v.status === 200 && v.posts > 0)
    .map(([k, v]) => ({ source: k, posts: v.posts, newest: v.newest }));

  console.log('%c=== accepted sources (returned posts) ===', 'font-weight:bold');
  console.table(accepted);
  console.log('%c=== full result ===', 'font-weight:bold');
  console.log(JSON.stringify(results, null, 2));

  const liked = results['MEDIA_POST_SOURCE_LIKED'];
  const better = accepted.filter(a => a.newest && liked?.newest && a.newest > liked.newest);
  console.log(better.length
    ? `%cFound ${better.length} source(s) with newer content than LIKED: ${better.map(b => b.source).join(', ')}`
    : '%cNo probed source returned anything newer than the liked feed.',
    'font-weight:bold');

  return results;
})();

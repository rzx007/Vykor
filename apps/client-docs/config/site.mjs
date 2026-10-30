/** Normalize an Astro deployment prefix without accepting an origin or traversal. */
export function documentationBase(value = '/') {
  const input=value.trim();
  if (/[:\\?#]/.test(input) || input.startsWith('//')) throw new Error('CLIENT_DOCS_BASE must be a site-relative path');
  const segments=input.split('/').filter(Boolean);
  if(segments.some(segment=>segment==='.' || segment==='..' || /%|\s/.test(segment))) {
    throw new Error('CLIENT_DOCS_BASE must contain plain path segments');
  }
  return segments.length ? `/${segments.join('/')}/` : '/';
}

export function documentationSite(value) {
  if(!value) return undefined;
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('CLIENT_DOCS_SITE must be a public HTTP(S) URL');
  return url.origin;
}

// Build a Sumo Logic UI link that reopens a search, so skills can hand the
// human a click-through for every finding. The UI host is derived from the
// API endpoint (api.<region>.sumologic.com -> service.<region>.sumologic.com)
// unless SUMO_UI_URL overrides it. Set SUMO_UI_URL=off to omit links.

export function uiBaseUrl(endpoint: string): string | undefined {
  const override = process.env.SUMO_UI_URL;
  if (override) {
    return override.toLowerCase() === 'off'
      ? undefined
      : override.replace(/\/$/, '');
  }
  try {
    const { hostname } = new URL(endpoint);
    if (!hostname.startsWith('api.') || !hostname.endsWith('sumologic.com')) {
      return undefined;
    }
    return `https://${hostname.replace(/^api\./, 'service.')}`;
  } catch {
    return undefined;
  }
}

export function searchUiLink(
  endpoint: string,
  query: string,
  fromMs: number,
  toMs: number,
): string | undefined {
  const base = uiBaseUrl(endpoint);
  if (!base) {
    return undefined;
  }
  const params = new URLSearchParams({
    query,
    startTime: String(fromMs),
    endTime: String(toMs),
  });
  return `${base}/ui/#/search/create?${params.toString()}`;
}

/* Optional: only needed if "Test ESPN connection" fails in the app.
   Free Cloudflare Worker that fetches ESPN for the app and adds the header browsers need.
   Setup: dash.cloudflare.com > Workers & Pages > Create > "Hello World" worker > Edit code,
   paste this whole file, Deploy, then put the worker's URL in the app's Settings > Proxy URL. */
export default {
  async fetch(request) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "accept" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const target = new URL(request.url).searchParams.get("url") || "";
    // Only forward ESPN API calls, so nobody can use your worker for anything else.
    if (!/^https:\/\/(site|site\.web|sports\.core)\.api\.espn\.com\//.test(target)) {
      return new Response("Only ESPN API URLs are allowed.", { status: 400, headers: cors });
    }
    const res = await fetch(target, { cf: { cacheTtl: 30, cacheEverything: true } });
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }
};

// Centralized admin API fetch wrapper (Issue 18).
//
// Two jobs, in one place so no call site can forget either:
//  1. Attach the custom CSRF header the mutating admin APIs require. sameSite=strict
//     cookies are the primary CSRF control; this header is defense in depth. It is
//     harmless on GETs (the server only enforces it on state-changing routes), so
//     every admin API call routes through here uniformly.
//  2. Redirect to the login page on 401 so an expired/destroyed session (e.g. after
//     logout in another tab) never wedges the UI mid-render.
window.adminFetch = async function adminFetch(url, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'X-Zyon-Admin': '1' }, opts.headers || {});
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    window.location.href = '/admin';
    // Never resolve: callers awaiting this won't process a redirect page as data.
    return new Promise(function () {});
  }
  return res;
};

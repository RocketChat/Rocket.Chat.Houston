// Realistic blend: mostly reads, some posts, an occasional login (and logout), with a
// step_<name> Trend per endpoint so the summary shows which call is slow.
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { URL, buildOptions, handleSummary, record, vuAuth, vuUser } from "./common.js";

export const options = buildOptions();
export { handleSummary };

const T = {
  read: new Trend("step_read", true),
  post: new Trend("step_post", true),
  login: new Trend("step_login", true),
  logout: new Trend("step_logout", true),
};

// Rocket.Chat keeps 50 login tokens per user and drops every older one, the
// token made before the run (that the reads and posts use) among them. Logging
// each new session straight out again keeps the count where it was.
function logout(login) {
  if (login.status !== 200) return;
  let data = null;
  try { data = login.json("data"); } catch (e) { data = null; }
  if (!data || !data.authToken) return;
  const res = http.post(`${URL}/api/v1/logout`, null, { headers: {
    "X-Auth-Token": data.authToken,
    "X-User-Id": data.userId,
  } });
  T.logout.add(res.timings.duration);
  record(res);
}

export default function () {
  const roll = Math.random();
  let res, name;
  if (roll < 0.6) {
    name = "read";
    res = http.get(`${URL}/api/v1/channels.history?roomName=general&count=20`, vuAuth());
  } else if (roll < 0.9) {
    name = "post";
    res = http.post(`${URL}/api/v1/chat.postMessage`,
      JSON.stringify({ channel: "#general", text: `k6 mixed ${__VU}-${__ITER}` }), vuAuth());
  } else {
    name = "login";
    const u = vuUser();
    res = http.post(`${URL}/api/v1/login`,
      JSON.stringify(u
        ? { user: u.username, password: u.password }
        : { user: __ENV.RC_USER || "admin", password: __ENV.RC_PASS || "admin123" }),
      { headers: { "Content-Type": "application/json" } });
  }
  T[name].add(res.timings.duration);
  record(res);
  check(res, { "status 200": (r) => r.status === 200 });
  if (name === "login") logout(res);
}

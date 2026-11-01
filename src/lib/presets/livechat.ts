/**
 * Dynamic `livechat` preset: Rocket.Chat Omnichannel with the Livechat widget embedded on
 * a separate "customer website".
 *
 * RC serves the widget itself at <ROOT_URL>/livechat, but the real ticket class is the widget
 * embedded on a THIRD-PARTY site -- a different origin from RC -- where CORS / CSP / iframe
 * issues live. So this preset ships a tiny nginx page on its own port that embeds the widget
 * pointing back at the repro, reproducing that cross-origin setup faithfully.
 *
 * Two things beyond env are required and handled at runtime (post_ready): an agent must
 * exist AND be marked *available for Omnichannel*, or every visitor sees "no agents
 * online". The admin user is made the agent by default.
 *
 * The embed snippet needs the repro's URL, which is not known until `up`; the generated
 * page uses the `{{ROOT_URL}}` placeholder that `runner.write` substitutes.
 *
 * Parameters (via `--set`):
 *   agents         number of agents to create + make available (default 1; admin is
 *                  always made an agent, extras are agent2..agentN).
 *   registration   show the pre-chat registration form first (default false).
 *   department     create an Omnichannel department (default true).
 */
import type { PortMap } from '../config';

import { guide } from './guides';
import { EMAIL_2FA, intParam, k8sManifests, presetPort, truthyParam } from './common';
import { type Params, register } from './registry';
import { emptyPreset, type Preset } from './types';

/**
 * A realistic-looking storefront so the widget sits in a believable page.
 *
 * Self-contained (inline CSS, emoji "product images") -- nginx serves it as-is. The
 * established text VERBATIM, because this string is written to disk in the workspace and
 * must be the bytes earlier releases wrote. `{{ROOT_URL}}` -> the repro URL at write time
 * (`runner.write`); `__WIDGET_PORT__` is substituted below.
 */
const WIDGET_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acme Store — Home</title>
  <style>
    :root { --ink:#1f2329; --muted:#6b7280; --brand:#1d74f5; --bg:#f7f8fa; --card:#fff; --line:#e6e8eb; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
    a { color: inherit; text-decoration: none; }
    header { position: sticky; top:0; background:var(--card); border-bottom:1px solid var(--line); }
    .bar { max-width:1080px; margin:0 auto; display:flex; align-items:center; gap:1.5rem; padding:1rem 1.25rem; }
    .logo { font-weight:800; font-size:1.35rem; letter-spacing:-.02em; }
    .logo span { color:var(--brand); }
    nav { display:flex; gap:1.25rem; color:var(--muted); font-weight:500; font-size:.95rem; }
    nav a:hover { color:var(--ink); }
    .cart { margin-left:auto; border:1px solid var(--line); border-radius:8px; padding:.5rem .8rem; font-weight:600; font-size:.9rem; }
    .hero { max-width:1080px; margin:0 auto; padding:3rem 1.25rem 1rem; }
    .hero h1 { font-size:2.4rem; margin:0 0 .5rem; letter-spacing:-.03em; }
    .hero p { color:var(--muted); font-size:1.1rem; margin:0 0 1.25rem; max-width:34rem; }
    .btn { display:inline-block; background:var(--brand); color:#fff; padding:.7rem 1.3rem; border-radius:8px; font-weight:600; }
    .grid { max-width:1080px; margin:1.5rem auto 4rem; padding:0 1.25rem; display:grid;
            grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:1.25rem; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
    .thumb { font-size:3.5rem; text-align:center; padding:2rem 0; background:linear-gradient(135deg,#eef2ff,#f7f8fa); }
    .card .body { padding:1rem; }
    .card h3 { margin:0 0 .25rem; font-size:1rem; }
    .card .price { color:var(--brand); font-weight:700; }
    .card .sub { color:var(--muted); font-size:.85rem; }
    footer { border-top:1px solid var(--line); background:var(--card); color:var(--muted); font-size:.85rem; }
    footer div { max-width:1080px; margin:0 auto; padding:1.5rem 1.25rem; }
    .demo { background:#fffbe6; border:1px solid #ffe58f; border-radius:8px; padding:.6rem .9rem;
            font-size:.85rem; color:#7a5c00; max-width:1080px; margin:1rem auto 0; }
  </style>
</head>
<body>
  <header>
    <div class="bar">
      <div class="logo">Acme<span>Store</span></div>
      <nav><a href="#">Shop</a><a href="#">Deals</a><a href="#">New</a><a href="#">Support</a></nav>
      <div class="cart">🛒 Cart (0)</div>
    </div>
  </header>

  <section class="hero">
    <h1>Gear that just works.</h1>
    <p>Free shipping over $50. Questions? Tap the chat bubble in the corner and
       one of our agents will help you out.</p>
    <a class="btn" href="#">Shop the sale</a>
  </section>

  <section class="grid">
    <div class="card"><div class="thumb">🎧</div><div class="body"><h3>Studio Headphones</h3><div class="price">$129</div><div class="sub">Noise cancelling</div></div></div>
    <div class="card"><div class="thumb">⌚</div><div class="body"><h3>Acme Watch 4</h3><div class="price">$199</div><div class="sub">7-day battery</div></div></div>
    <div class="card"><div class="thumb">📷</div><div class="body"><h3>Pocket Camera</h3><div class="price">$249</div><div class="sub">4K, tiny</div></div></div>
    <div class="card"><div class="thumb">⌨️</div><div class="body"><h3>Mech Keyboard</h3><div class="price">$89</div><div class="sub">Hot-swap</div></div></div>
    <div class="card"><div class="thumb">🔋</div><div class="body"><h3>Power Bank</h3><div class="price">$39</div><div class="sub">20,000 mAh</div></div></div>
    <div class="card"><div class="thumb">🖱️</div><div class="body"><h3>Wireless Mouse</h3><div class="price">$29</div><div class="sub">Silent click</div></div></div>
  </section>

  <div class="demo">houston Livechat demo — this storefront (origin
     <code>http://localhost:__WIDGET_PORT__</code>) embeds your Rocket.Chat Livechat
     widget cross-origin. Start a chat here, answer it in Rocket.Chat's Omnichannel area.</div>

  <footer><div>© Acme Store — demo site for Rocket.Chat Omnichannel. Not a real shop.</div></footer>

  <script type="text/javascript">
  (function(w, d, s, u) {
    w.RocketChat = function(c) { w.RocketChat._.push(c) }; w.RocketChat._ = []; w.RocketChat.url = u;
    var h = d.getElementsByTagName(s)[0], j = d.createElement(s);
    j.async = true; j.src = u + '/rocketchat-livechat.min.js?_=' + Math.random();
    h.parentNode.insertBefore(j, h);
  })(window, document, 'script', '{{ROOT_URL}}/livechat');
  </script>
</body>
</html>
`;

/** Render the static storefront with the workspace's host port for it. */
function widgetPage(port: number): string {
  return WIDGET_PAGE.split('__WIDGET_PORT__').join(String(port));
}

/** Compose service for the separate customer-site origin. */
function widgetService(port: number): Record<string, Record<string, unknown>> {
  return {
    'widget-site': {
      image: 'docker.io/nginx:alpine', // multi-arch
      volumes: ['./livechat/index.html:/usr/share/nginx/html/index.html:ro'],
      ports: [`${String(port)}:80`],
      restart: 'unless-stopped',
    },
  };
}

/** Rocket.Chat settings that permit and route the cross-origin widget. */
function livechatSettings(registration: boolean): Record<string, string> {
  return {
    OVERWRITE_SETTING_Livechat_enabled: 'true',
    // The widget calls RC from a different origin (the nginx page), so CORS must be open
    // -- and this is exactly the knob behind "widget won't load on our site" tickets.
    OVERWRITE_SETTING_API_Enable_CORS: 'true',
    OVERWRITE_SETTING_API_CORS_Origin: '*',
    // The widget embeds RC in an IFRAME. RC defaults to X-Frame-Options: sameorigin,
    // which browsers refuse to frame from another origin ("Refused to display ... in a
    // frame"). Dropping the restriction lets the widget load on the demo site. (Livechat
    // allowed domains -- Livechat_AllowedDomainsList -- is empty = all origins.)
    OVERWRITE_SETTING_Iframe_Restrict_Access: 'false',
    // Route each visitor to any available agent (simplest).
    OVERWRITE_SETTING_Livechat_Routing_Method: 'Auto_Selection',
    OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: 'false',
    OVERWRITE_SETTING_Livechat_registration_form: registration ? 'true' : 'false',
  };
}

/** Operator guidance for exercising the customer and agent sides. */
function livechatNotes(widgetUrl: string): string[] {
  return [
    `Customer website (widget embedded, cross-origin): ${widgetUrl}`,
    'Built-in standalone widget (same-origin): <workspace-url>/livechat',
    "admin is an available Omnichannel agent, assigned to the 'support'",
    "  department. Visitors see 'agents online' once you're logged into RC",
    "  (that gives you presence); answer chats in RC's Omnichannel area.",
    'Business hours & canned responses are Enterprise features — a registration',
    '  token (--reg-token, or More options when creating) enables them, else',
    '  configure them by hand.',
  ];
}

/** The customer-site workload, page ConfigMap, and published Service. */
function widgetManifests(port: number): string {
  return k8sManifests({
    name: 'widget-site',
    image: 'docker.io/nginx:alpine',
    ports: [[port, 80]],
    files: { 'index.html': widgetPage(port) },
    mounts: [
      {
        name: 'files',
        mountPath: '/usr/share/nginx/html/index.html',
        subPath: 'index.html',
      },
    ],
    readiness: {
      httpGet: { path: '/', port: 80 },
      initialDelaySeconds: 2,
      periodSeconds: 3,
      failureThreshold: 30,
    },
    ui: { 'widget-site': [port, 80] },
  });
}

export function build(params: Params, ports: PortMap): Preset {
  const agents = Math.max(1, intParam(params, 'agents', 1));
  const registration = truthyParam(params, 'registration');
  const department = truthyParam(params, 'department', true); // created by default
  const port = presetPort('livechat', 0, ports);
  const widgetUrl = `http://localhost:${String(port)}`;
  return {
    ...emptyPreset('livechat'),
    description:
      'Rocket.Chat Omnichannel with the Livechat widget embedded on a ' +
      `separate demo website (${widgetUrl}). Reproduce widget-load / CORS ` +
      '/ routing / agent-availability tickets. Admin is the agent.',
    env: livechatSettings(registration),
    softEnv: [EMAIL_2FA],
    services: widgetService(port),
    dependsOn: ['widget-site'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    files: [['livechat/index.html', widgetPage(port)]],
    ports: [port],
    kubernetesManifests: [widgetManifests(port)],
    paramsHelp: {
      agents: 'agents to create + assign to the department (default 1; admin is always an agent)',
      registration: 'show the pre-chat registration form (default false)',
      department: "create a 'support' department + assign the agents (default true)",
    },
    postReady: [
      {
        action: 'livechat_setup',
        agents,
        department: department ? 'support' : '',
      },
    ],
    notes: livechatNotes(widgetUrl),
    guides: [
      guide('livechat', {
        summary: 'Omnichannel with the Livechat widget on a separate demo website.',
        signIn: [
          [
            'admin',
            'the Rocket.Chat password above',
            `the Omnichannel agent${department ? ", department 'support'" : ''}`,
          ],
        ],
        steps: [
          "Sign in to Rocket.Chat as admin: that gives presence, so visitors see 'agents online'.",
          'Open the customer website, or the built-in widget at <workspace-url>/livechat, and start a chat.',
          "Answer it in Rocket.Chat's Omnichannel area.",
        ],
        know: [
          agents > 1 ? `${String(agents)} agents are created and assigned to the department.` : '',
          'Business hours and canned responses are Enterprise features: a registration token (--reg-token, or Registration token under More options when creating) enables them, or configure them by hand.',
        ],
      }),
    ],
  };
}

register('livechat', build);

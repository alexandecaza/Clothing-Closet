// DEMO MODE ONLY — a stand-in for the Supabase client, used by dev/server.py.
// Data lives in this browser's localStorage, so the catalog and admin share
// it. It imitates the real rules closely enough for trying out page changes,
// but it is NOT the real database: test database changes against a real test
// project instead (README → "Testing changes locally").
//
// Coordinator sign-in: any email, password "demo". Two-step sign-in code:
// 123456 (any authenticator setup is accepted with that code too).
// Start over with fresh sample data: add ?reset-demo to the address.

const KEY = 'closet.demo-db.v1';
const DEMO_PASSWORD = 'demo';
const DEMO_CODE = '123456';
const DEMO_QR = 'data:image/svg+xml;utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" fill="#fff"/>' +
  '<rect x="10" y="10" width="160" height="160" fill="none" stroke="#2b3a31" stroke-width="4" stroke-dasharray="8 6"/>' +
  '<text x="90" y="86" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#2b3a31">Demo QR</text>' +
  '<text x="90" y="108" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#2b3a31">code: 123456</text></svg>');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const ago = (hours) => new Date(Date.now() - hours * 36e5).toISOString();

function seed() {
  const item = (name, category, size, gender, condition, quantity, photo = true, notes = '') => {
    const id = uuid();
    const path = photo ? `demo/${id}.svg` : null;
    return { id, name, category, size, gender, condition, quantity, notes,
      photo_path: path, thumb_path: path, created_at: now(), updated_at: now() };
  };
  const items = [
    item('Striped cotton onesie', 'One-pieces & sets', '0-3M', 'Unisex', 'Like new', 4),
    item('Fleece sleeper, bears', 'Sleepwear', '6-9M', 'Unisex', 'Gently used', 2),
    item('Denim overalls', 'One-pieces & sets', '2T', 'Boys', 'Gently used', 1, true, 'Bin C'),
    item('Yellow rain jacket', 'Outerwear', '4T', 'Unisex', 'New with tags', 3),
    item('Floral party dress', 'Dresses & skirts', '5T', 'Girls', 'Like new', 1),
    item('Graphic tee, dinosaurs', 'Tops', '7', 'Boys', 'Gently used', 5),
    item('Winter puffer coat', 'Outerwear', '10', 'Girls', 'Like new', 0, true, 'Donated at the fall drive'),
    item('Jeans, slim fit', 'Bottoms', '12', 'Boys', 'Gently used', 2),
    item('Hoodie, navy', 'Tops', 'M', 'Unisex', 'New with tags', 6),
    item('Swim set', 'Swimwear', '6', 'Girls', 'New with tags', 1, false),
  ];
  const line = (i, qty) => ({ itemId: items[i].id, name: items[i].name, size: items[i].size, qty });
  const requests = [
    { id: uuid(), ref_code: 'K7PQ3X', family_name: 'Dana R.', contact: 'dana@example.org',
      note: 'Two kids, ages 4 and 7.', items: [line(3, 2), line(4, 1)], total_qty: 3,
      status: 'pending', stock_reserved: false, created_at: ago(1), updated_at: ago(1) },
    { id: uuid(), ref_code: 'M2HT9W', family_name: 'The Okafor family', contact: '(555) 201-3344',
      note: '', items: [line(5, 1), line(1, 1)], total_qty: 2,
      status: 'pending', stock_reserved: false, created_at: ago(26), updated_at: ago(26) },
  ];
  return {
    items,
    requests,
    settings: [{ id: 1, org_name: 'Demo Clothing Closet', max_items_per_request: 5, updated_at: now() }],
    session: null,
    factors: [],
  };
}

if (new URLSearchParams(location.search).has('reset-demo')) {
  localStorage.removeItem(KEY);
  history.replaceState(null, '', location.pathname + location.hash);
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) return saved;
  } catch { /* fall through */ }
  const fresh = seed();
  save(fresh);
  return fresh;
}
const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
const delay = () => new Promise((r) => setTimeout(r, 150));
const fail = (message, code) => ({ data: null, error: { message, code } });
const copy = (v) => JSON.parse(JSON.stringify(v));

class Query {
  constructor(table, admin) {
    Object.assign(this, { table, admin, filters: [], mode: 'select' });
  }
  select() { return this; }
  insert(value) { Object.assign(this, { mode: 'insert', value }); return this; }
  update(value) { Object.assign(this, { mode: 'update', value }); return this; }
  delete() { this.mode = 'delete'; return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  order(column, { ascending = true } = {}) { this.sort = [column, ascending]; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  then(resolve, reject) { return delay().then(() => this.run()).then(resolve, reject); }

  run() {
    const db = load();
    const rows = db[this.table];
    const match = (r) => this.filters.every(([c, v]) => r[c] === v);
    if (this.table === 'requests' && !this.admin) return fail('permission denied for table requests', '42501');
    if (this.mode !== 'select' && !this.admin) return fail('permission denied', '42501');

    let out;
    if (this.mode === 'select') {
      out = rows.filter(match);
      if (this.table === 'items' && !this.admin) out = out.map(({ notes, ...rest }) => rest);
      if (this.sort) {
        const [c, asc] = this.sort;
        out.sort((a, b) => (asc ? 1 : -1) * String(a[c]).localeCompare(String(b[c])));
      }
    } else if (this.mode === 'insert') {
      const row = { created_at: now(), updated_at: now(), ...this.value };
      rows.push(row);
      out = [row];
    } else if (this.mode === 'update') {
      if (this.table === 'requests' && 'status' in this.value) {
        return fail("Use the buttons in the admin to change a request's status, so stock stays correct.");
      }
      out = rows.filter(match);
      out.forEach((r) => Object.assign(r, this.value, { updated_at: now() }));
    } else {
      out = rows.filter(match);
      if (this.table === 'requests' && out.some((r) => r.status === 'approved' && r.stock_reserved)) {
        return fail('This request is holding items for pickup. Deny it or move it back to pending first.');
      }
      db[this.table] = rows.filter((r) => !match(r));
    }
    save(db);
    out = copy(out);
    if (this.one === 'single') {
      return out.length === 1 ? { data: out[0], error: null }
        : fail('JSON object requested, multiple (or no) rows returned', 'PGRST116');
    }
    if (this.one === 'maybe') return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
}

const rpcs = {
  is_admin: (db, args, admin) => ({ data: admin, error: null }),

  is_admin_account: (db) => ({ data: Boolean(db.session), error: null }),

  bot_protection_status: () => ({ data: { turnstile_secret: true }, error: null }),

  submit_request(db, args) {
    const no = (error) => ({ data: { ok: false, error }, error: null });
    if (!args.p_captcha_token) return no('Please complete the “I’m not a robot” check, then send again.');
    if (!args.p_family_name?.trim()) return no('Please enter your name (up to 100 characters).');
    const max = db.settings[0].max_items_per_request;
    let total = 0;
    const lines = [];
    for (const { item_id, qty } of args.p_items) {
      const item = db.items.find((i) => i.id === item_id);
      if (!item) return no('One of the items on your list is no longer available. Please refresh and try again.');
      if (qty > item.quantity) return no(`"${item.name}" only has ${item.quantity} available right now. Please adjust your list.`);
      total += qty;
      lines.push({ itemId: item.id, name: item.name, size: item.size, qty });
    }
    if (total > max) return no(`Requests are limited to ${max} items at a time.`);
    const ref = Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
    db.requests.push({ id: uuid(), ref_code: ref, family_name: args.p_family_name.trim(), contact: args.p_contact,
      note: args.p_note, items: lines, total_qty: total, status: 'pending', stock_reserved: false,
      created_at: now(), updated_at: now() });
    save(db);
    return { data: { ok: true, ref }, error: null };
  },

  request_status(db, args) {
    const code = String(args.p_ref).replace(/[^a-z0-9]/gi, '').toUpperCase();
    const rows = db.requests.filter((r) => r.ref_code === code)
      .map(({ status, created_at, updated_at }) => ({ status, created_at, updated_at }));
    return { data: rows, error: null };
  },

  change_request_status(db, { p_id, p_status: to }, admin) {
    if (!admin) return fail('Not authorized.');
    const r = db.requests.find((x) => x.id === p_id);
    if (!r) return fail('Request not found.');
    const itemFor = (l) => db.items.find((i) => i.id === l.itemId);
    if (to === 'approved') {
      if (r.status !== 'pending') return fail('Only pending requests can be approved.');
      const short = r.items.filter((l) => !itemFor(l) || itemFor(l).quantity < l.qty);
      if (short.length) return fail(`Not enough stock to approve. ${short.map((l) => l.name).join(', ')}`);
      r.items.forEach((l) => { itemFor(l).quantity -= l.qty; });
      r.stock_reserved = true;
    } else if (r.status === 'approved' && (to === 'pending' || to === 'denied')) {
      if (r.stock_reserved) r.items.forEach((l) => { if (itemFor(l)) itemFor(l).quantity += l.qty; });
      r.stock_reserved = false;
    } else if (to === 'fulfilled') {
      if (r.status !== 'approved') return fail('Approve the request before marking it picked up.');
      r.stock_reserved = false;
    } else if (!(r.status === 'pending' && to === 'denied') && !(r.status === 'denied' && to === 'pending')) {
      return fail(`A request can't go from ${r.status} to ${to}.`);
    }
    r.status = to;
    r.updated_at = now();
    save(db);
    return { data: copy(r), error: null };
  },
};

export function makeClient({ persistSession }) {
  const listeners = [];
  const session = () => (persistSession ? load().session : null);
  // Like the real database: only sessions that passed two-step sign-in count.
  const isAdmin = () => session()?.aal === 'aal2';
  const emit = (event, s) => listeners.forEach((fn) => fn(event, s));
  const factorsOf = (db) => (db.factors ??= []);

  const mfa = {
    async getAuthenticatorAssuranceLevel() {
      await delay();
      const db = load();
      const verified = factorsOf(db).some((f) => f.status === 'verified');
      return { data: { currentLevel: db.session?.aal ?? null, nextLevel: verified ? 'aal2' : 'aal1' }, error: null };
    },
    async listFactors() {
      await delay();
      const all = copy(factorsOf(load()));
      return { data: { all, totp: all.filter((f) => f.status === 'verified'), phone: [] }, error: null };
    },
    async enroll({ friendlyName }) {
      await delay();
      const db = load();
      if (factorsOf(db).some((f) => f.status === 'verified') && db.session?.aal !== 'aal2') {
        return fail('AAL2 required to enroll a new factor', 'insufficient_aal');
      }
      const factor = { id: uuid(), friendly_name: friendlyName, factor_type: 'totp', status: 'unverified',
        created_at: now(), updated_at: now() };
      db.factors.push(factor);
      save(db);
      return { data: { id: factor.id, type: 'totp', totp: { qr_code: DEMO_QR, secret: 'DEMO DEMO DEMO DEMO', uri: '' } }, error: null };
    },
    async unenroll({ factorId }) {
      await delay();
      const db = load();
      db.factors = factorsOf(db).filter((f) => f.id !== factorId);
      save(db);
      return { data: { id: factorId }, error: null };
    },
    async challengeAndVerify({ factorId, code }) {
      await delay();
      const db = load();
      const factor = factorsOf(db).find((f) => f.id === factorId);
      if (!factor || !db.session) return fail('Factor not found', 'mfa_factor_not_found');
      if (code !== DEMO_CODE) return fail('Invalid TOTP code entered (demo code is 123456)', 'mfa_verification_failed');
      factor.status = 'verified';
      db.session.aal = 'aal2';
      save(db);
      emit('MFA_CHALLENGE_VERIFIED', db.session);
      return { data: {}, error: null };
    },
  };

  return {
    from: (table) => new Query(table, isAdmin()),

    async rpc(name, args = {}) {
      await delay();
      const handler = rpcs[name];
      if (!handler) return fail(`Demo mode doesn't know the function "${name}".`);
      return handler(load(), args, isAdmin());
    },

    storage: {
      from: () => ({
        async upload(path, blob) {
          const res = await fetch(`/mock-storage/${path}`, { method: 'PUT', body: blob });
          return res.ok ? { data: { path }, error: null } : fail('Upload failed.');
        },
        async remove() { return { data: [], error: null }; },
      }),
    },

    auth: {
      mfa,
      onAuthStateChange(fn) {
        listeners.push(fn);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async getSession() {
        await delay();
        return { data: { session: session() } };
      },
      async signInWithPassword({ email, password }) {
        await delay();
        if (password !== DEMO_PASSWORD) {
          return { data: {}, error: { message: 'Invalid login credentials (demo password is "demo")' } };
        }
        const db = load();
        db.session = { user: { id: 'demo-user', email }, aal: 'aal1' };
        save(db);
        emit('SIGNED_IN', db.session);
        return { data: { user: db.session.user, session: db.session }, error: null };
      },
      async signOut({ scope = 'global' } = {}) {
        if (scope === 'others') return { error: null }; // no other devices in demo mode
        const db = load();
        db.session = null;
        save(db);
        emit('SIGNED_OUT', null);
        return { error: null };
      },
      async updateUser() {
        await delay();
        return { data: { user: session()?.user }, error: null };
      },
      async resetPasswordForEmail() {
        await delay();
        return { data: {}, error: null };
      },
    },
  };
}

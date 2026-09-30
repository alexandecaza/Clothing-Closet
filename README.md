# Clothing Closet

A free clothing-closet web app for foster families.

- **Families** open the link, browse donated clothes, build a request list, and send it with their name and a phone number or email. No account, no payment, nothing ships automatically.
- **Coordinators** sign in to manage stock (with photos), work through the request queue, and adjust settings.

It's a plain static site (HTML/CSS/JS, no build step) hosted free on **Cloudflare Pages**. Data, sign-in and photos live in **Supabase** (free tier).

> **Why Supabase and not Firebase?** Firebase Storage (needed for photos) now requires the paid Blaze plan for new projects. Supabase's free tier includes the database, sign-in and file storage with no card on file. Its Postgres functions also let the server enforce the "max items per request" cap and the pickup/stock logic.

---

## What's in the folder

```
index.html              Public catalog (families)
admin/index.html        Coordinator admin (sign-in required)
css/styles.css          All styles: neutral theme, hover and motion effects
js/config.js            ← your Supabase URL and public keys go here (live + optional local test)
js/constants.js         Sizes, categories, conditions (edit to fit your closet)
js/shared.js            Helpers used by both pages
js/image.js             In-browser photo resizing before upload
js/shader.js            Animated WebGL background (decorative; plain colour if unsupported)
js/motion.js            Card hover tilt/glow and the scrolled-header shadow
js/turnstile.js         Cloudflare Turnstile robot check (bot protection)
js/catalog.js           Catalog logic
js/admin.js             Admin logic
js/supabase-client.js   Loads the Supabase library from a CDN
supabase/schema.sql     Database tables, security rules, storage rules
_headers                Security headers for Cloudflare Pages / Workers
.assetsignore           Files Cloudflare Workers must not publish (.git, README, dev/, …)
dev/server.py           Local preview server: demo mode or test-database mode
dev/mock-supabase.js    Fake database used by demo mode (never deployed)
.github/workflows/keepalive.yml   Optional: keeps the free Supabase project awake
```

---

## Setup, from zero to a live site

Plan for about 30 minutes. You need a free [GitHub](https://github.com), [Supabase](https://supabase.com) and [Cloudflare](https://dash.cloudflare.com/sign-up) account.

### 1. Create the Supabase project

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Pick a name (e.g. `clothing-closet`), set a strong database password (save it somewhere), and choose the region closest to you.
3. Wait a minute or two for it to finish setting up.

### 2. Create the database, security rules and photo storage

1. In your project, open **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this folder, copy **all** of it, paste it in, and click **Run**.
3. You should see "Success. No rows returned."

That one script creates:
- the `items`, `requests`, `settings` and `admins` tables;
- Row Level Security policies (the real access rules, see [Security](#how-the-security-works));
- the `submit_request`, `request_status` and `change_request_status` server functions;
- a public-read `item-photos` storage bucket that only coordinators can write to.

You can safely run it again later, for example after updating the project.

### 3. Lock down sign-in

Only coordinators should have accounts.

1. Go to **Authentication** → **Sign In / Providers** (on some dashboards it's under **Authentication → Settings**).
2. Turn **off** "Allow new users to sign up".
3. Leave the **Email** provider enabled. Coordinators sign in with email and password.
4. Open the **Email** provider and set **Minimum password length** to **12**. Save.
5. Open **Authentication** → **Multi-Factor** and check that **TOTP (App Authenticator)** is **Enabled**. It is by default.

Even if sign-ups were left on, a random account gets nothing: the rules only trust accounts listed in the `admins` table (step 5), and only after two-step sign-in (see [Two-step sign-in](#two-step-sign-in)).

### 4. Connect the site to Supabase

1. In Supabase, open **Project Settings** → **API Keys** (or click **Connect** at the top of the dashboard).
2. Copy the **Project URL**, e.g. `https://abcdxyz.supabase.co`.
3. Copy the **publishable** key (`sb_publishable_…`). On older projects this is called the **anon public** key; either works.
4. Open `js/config.js` and paste them into the `LIVE` section:

   ```js
   const LIVE = {
     SUPABASE_URL: 'https://abcdxyz.supabase.co',
     SUPABASE_ANON_KEY: 'sb_publishable_...',
     TURNSTILE_SITE_KEY: '', // filled in at step 9
   };
   ```

These two values are *meant* to be public. Every visitor's browser uses them, and the database rules decide what each visitor may do. **Never** put the `service_role` / secret key in this file.

### 5. Create the first coordinator account

1. In Supabase go to **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter the coordinator's email and a password of at least 12 characters, and tick **Auto Confirm User**. Click **Create user**.
3. Go back to **SQL Editor** → **New query** and run this, using that email:

   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'coordinator@example.org';
   ```

Repeat for each coordinator. The first time each coordinator signs in, the admin walks them through setting up two-step sign-in with an authenticator app on their phone. Ask them to do it straight away: until they do, anyone with their password could set it up instead.

To remove someone's access:

```sql
delete from public.admins
where user_id = (select id from auth.users where email = 'coordinator@example.org');
```

### 6. Put the code on GitHub

1. On GitHub, click **New repository**, name it (e.g. `clothing-closet`), and create it. Public or private both work.
2. Upload this folder's contents, with `js/config.js` already filled in. Either:
   - **In the browser:** on the new repo page, choose **uploading an existing file**, drag in everything from this folder (including the `admin`, `css`, `js`, `supabase` and `.github` folders and the `_headers` file), then **Commit changes**; or
   - **With git:**
     ```bash
     git init
     git add .
     git commit -m "Clothing closet"
     git branch -M main
     git remote add origin https://github.com/YOUR-NAME/clothing-closet.git
     git push -u origin main
     ```

### 7. Deploy on Cloudflare Pages

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Authorize GitHub and pick your repository.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `/`
4. Click **Save and Deploy**. After a minute you get a URL like `https://clothing-closet.pages.dev`.
5. Back in Supabase, go to **Authentication** → **URL Configuration**:
   - set **Site URL** to your Pages URL (e.g. `https://clothing-closet.pages.dev`);
   - under **Redirect URLs**, add `https://clothing-closet.pages.dev/admin/`.

   This makes "Forgot password?" emails link back to your admin page.

You're live:
- Families: `https://clothing-closet.pages.dev/`
- Coordinators: `https://clothing-closet.pages.dev/admin/`

Every push to `main` redeploys automatically.

> **Deploying as a Cloudflare Worker (`*.workers.dev`) instead of Pages?** Workers publish every file in the folder unless told otherwise. The included `.assetsignore` keeps `.git`, `README.md`, `supabase/` and other non-website files private, so keep it in the repo. After deploying, check that `https://YOUR-SITE/.git/HEAD` returns "not found". To use your own domain, go to **Custom domains** in the Pages project, then add that domain to Supabase's Site URL / Redirect URLs too.

### 8. (Recommended) Keep the free project awake

Supabase pauses free projects after about a week without activity. A quiet closet could go offline between donation drives, and you'd have to click **Restore** in the dashboard. The included GitHub Action reads one row every 3 days to prevent this:

1. In your GitHub repo, open **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, and add:
   - `SUPABASE_URL`: your project URL
   - `SUPABASE_ANON_KEY`: the same publishable/anon key
2. Open the **Actions** tab, enable workflows if asked, pick **Keep Supabase awake**, and click **Run workflow** once to test it.

(GitHub may disable scheduled workflows in repos with no commits for 60 days. If that happens it'll email you, and you can re-enable it from the Actions tab.)

### 9. Turn on bot protection (Cloudflare Turnstile)

The request form is public, so bots could flood the closet with fake requests. Turnstile is Cloudflare's free robot check. Most people never see it; it only shows a checkbox when Cloudflare isn't sure. The database checks every token with Cloudflare itself, so bots can't skip it by calling the API directly.

Do these in order, so the live site never asks for a check it can't show.

1. **Create the widget.** In the [Cloudflare dashboard](https://dash.cloudflare.com), open **Turnstile** (search for it if it's not in the sidebar) → **Add widget**.
   - Name: e.g. `Clothing Closet`
   - Hostnames: the exact address people use, e.g. `clothing-closet.pages.dev` or, if you deployed as a Worker, `clothing-closet.YOUR-NAME.workers.dev`, plus any custom domain. Add `localhost` too if you test locally. If the address isn't listed, the check silently fails with Cloudflare error **110200** and nobody can send requests.
   - Widget mode: **Managed**
   - Click **Create**, then copy the **Site Key** and the **Secret Key**.
2. **Put the site key in the website.** In `js/config.js`, in the `LIVE` section:
   ```js
   TURNSTILE_SITE_KEY: '0x4AAAAAAA...',
   ```
   Commit and push, then wait for Cloudflare Pages to finish deploying.
3. **Give the secret key to the database.** In Supabase → **SQL Editor**, run:
   ```sql
   select vault.create_secret('YOUR-TURNSTILE-SECRET-KEY', 'turnstile_secret');
   ```
   From now on, requests without a valid robot check are refused. (To change the key later: `select vault.update_secret((select id from vault.secrets where name = 'turnstile_secret'), 'NEW-SECRET');`)
4. **Protect coordinator sign-in too.** In Supabase → **Authentication** → **Attack Protection** (called "Bot and Abuse Protection" on some dashboards), turn on **CAPTCHA protection**. Choose **Turnstile by Cloudflare**, paste the same **secret key**, and save.
5. **Check it:** sign in to the admin → **Settings** → **Bot protection**. All three lines should say **On**.

> **Set up the closet before bot protection was added?** Re-run the whole `supabase/schema.sql` once (step 2). It's safe to re-run, and it adds the new protections.

> **Set up the closet before two-step sign-in was added?** Do step 3's password and Multi-Factor settings, then re-run `supabase/schema.sql` in the live project **and push the new site right away**. The new database rules and the new admin page need each other: until both are live, coordinators can't get in. Each coordinator is asked to set up their authenticator app at their next sign-in.

Even before Turnstile is set up, these limits are already on:
- **5 request attempts per hour** from one internet connection
- **3 requests per day** from the same phone number or email
- **40 new requests per hour** for the whole closet: a circuit breaker if a flood gets through
- **20 status lookups per hour** from one connection, so reference codes can't be guessed in bulk

To change these numbers, edit the constants at the top of `public.submit_request` in `schema.sql` and re-run it.

---

## Using it

### Families
- Tap sizes on the **ruler** (pick several if you have more than one child), and narrow by category, boys/girls/unisex, condition, or search.
- **Add to list** on anything that fits. The list is capped at the closet's per-request limit (5 by default) and at what's in stock.
- Open **Request list**, add a name and a phone number or email, and send. You get a reference code; "Check its status" at the bottom of the page looks it up later.

### Coordinators
- **Inventory:** use − / + or type a number to change stock; it saves automatically. **Edit** opens the full form. **Save & add another** keeps the category/size/gender/condition filled in, for entering a pile of donations quickly. Setting stock to 0 takes an item out of the default catalog view without deleting it. Families only see it if they turn on "Show out-of-stock", and they can't request it.
- **Photos** are resized in the browser to 1200px (plus a 240px thumbnail) before upload, so a 5 MB phone photo becomes roughly 150 KB.
- **Requests** move **Pending → Approved → Picked up**, or **Denied**:
  - *Approve* **sets the items aside**: they come out of stock immediately, so no other family can see them as available or request them while you arrange pickup. A confirmation shows exactly how stock will change. If there isn't enough stock, approval is refused and you're told which items are short.
  - *Mark picked up* closes the request. Stock doesn't change again, because the items already came out at approval.
  - *Deny*, or *Back to pending*, on an approved request puts its set-aside items back into stock. Denying a pending request changes nothing. The app doesn't send messages, so let the family know yourself.
  - In **Inventory**, "+ 2 set aside for pickup" under a stock number means two more are on the shelf, waiting for an approved family. Pieces on your shelf = stock + set aside.
  - A **"Stock short"** flag means a pending request asks for more than is available. **"Competing requests"** means several pending requests together want more than you have; whoever you approve first gets the items.
  - Once a request is picked up it's final. Records can be deleted for privacy once they're picked up or denied.
- **Settings:** closet name, max items per request (the server enforces it too), and changing your password. Changing it needs a code from your authenticator app and signs out your other devices.

### Two-step sign-in

Coordinators sign in with their password **and** a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 2FAS, 1Password…). The code changes every 30 seconds. This keeps families' names and contact details safe even if a coordinator's password is guessed, reused elsewhere, or phished.

- **First sign-in:** the admin shows a QR code. Scan it in the authenticator app and type the code it shows.
- **Every sign-in after that:** password, then the current code.
- **Forgot password?** The reset email link still asks for the code before you can choose a new password.
- **Idle sign-out:** the admin signs you out after 30 minutes without clicks, taps or typing, including in tabs you left open.

**Lost or replaced phone.** Someone with access to the Supabase dashboard runs this in the **SQL Editor**, using the coordinator's email:

```sql
delete from auth.mfa_factors
where user_id = (select id from auth.users where email = 'coordinator@example.org');
```

The coordinator then signs in with their password and sets up the new phone. Only do this once you're sure it's really them asking, e.g. by phone or in person, not only by email.

### Customizing sizes and categories
Edit the lists in `js/constants.js`. The ruler, filters and forms all use them. Items you've already saved keep their old values, so rename carefully. Shoes aren't included by default because shoe sizes don't fit the clothing ruler. If you want them, add a "Shoes" category and pick the closest size band, or add shoe sizes as their own band in `SIZE_BANDS`.

---

## How the security works

All rules live in `supabase/schema.sql` and are enforced by the database, not the web page. Hiding a button in the UI is never what keeps data safe.

| Who | Can | Can't |
|---|---|---|
| Public (no login) | Read items (except **internal notes**, which are withheld at the column level), read settings, create a request **only through `submit_request()`**, which needs a valid robot check and is rate-limited, and look up a request's **status** by reference code (also rate-limited) | Read any request or anyone's contact info; add, edit or delete items; change settings; upload photos |
| Signed-in account **not** in `admins` | Nothing beyond the public | Same as above |
| Coordinator who entered only a password (no 6-digit code yet) | Nothing beyond the public, apart from setting up or entering their code | Same as above |
| Coordinator (in `admins`) who passed two-step sign-in | Everything: items, photos, requests, settings | Change a request's status without going through `change_request_status()` (which moves stock in the same step); delete a request that's holding items; edit what a family asked for |

`submit_request()` re-checks everything on the server: that the name and contact are present, that every item exists and has enough stock, and that the total is under the cap. It copies item names and sizes from the database, not from the browser. The page's own checks are only there for convenience.

**Coordinator sign-in:**
- **Two-step sign-in is enforced by the database.** `is_admin()` only says yes when the session passed both the password and the authenticator code (Supabase calls this `aal2`). Every table rule, admin function and photo-upload rule goes through it, so skipping the code screen, or calling the API with just a password, gets nothing.
- Passwords: at least 12 characters (the page also rejects obvious ones), with the same minimum set in Supabase (step 3).
- Changing a password needs a fresh code, and signs out every other device. So does resetting a forgotten password.
- Automatic sign-out after 30 minutes idle. **Sign out** ends the session on every device.
- Supabase Auth limits how many sign-in, reset and code attempts can be made.
- The admin page is never cached (`Cache-Control: no-store`), can't be framed by other sites, and is only served over HTTPS (`Strict-Transport-Security`).

**Bots and spam** (see [step 9](#9-turn-on-bot-protection-cloudflare-turnstile)):
- **Robot check:** Cloudflare Turnstile on the request form and on coordinator sign-in / password reset. The database and Supabase Auth verify the tokens with Cloudflare. Each token works once, so it can't be replayed.
- **Rate limits in the database:** per internet connection (requests and status lookups), per phone/email, plus a closet-wide hourly ceiling. Only a one-way hash of the visitor's IP is stored, and it's deleted after a day.
- **Supabase Auth's own limits** on sign-in and password-reset attempts.
- A hidden honeypot field that simple form-filling bots fall into.
- The helper functions live in a `private` database schema that the public API can't reach.

---

## Testing changes locally

Try changes on your own computer first, then push to GitHub when they work. Pushing to `main` is what updates the live site.

You need Python (already installed if `python --version` works). Run these commands from the project folder. Stop the server with **Ctrl+C**.

### Demo mode: no setup, fake data

```bash
python dev/server.py
```

Open <http://localhost:8765> (catalog) and <http://localhost:8765/admin/> (admin).

- A yellow **Demo mode** bar shows at the top. Everything is sample data kept in your browser, and nothing online is touched.
- Coordinator sign-in: **any email, password `demo`**, then two-step code **`123456`** (the first time, "set up" accepts that code too).
- Start over with fresh sample data: <http://localhost:8765/?reset-demo>
- Best for page, style and wording changes. Just save the file and refresh the browser.

Demo mode imitates the database but **isn't** the real one, so use test mode for database changes.

### Test mode: a real, separate test database

A second free Supabase project gives you the real database, sign-in and photo storage, with none of your live families' data.

1. In Supabase, create another project, e.g. `clothing-closet-test`. The free plan allows two.
2. Set it up like the live one: run `supabase/schema.sql` in its **SQL Editor** (step 2), and create yourself a coordinator (step 5).
3. Give it Cloudflare's test robot-check secret, which always passes. In its SQL Editor:
   ```sql
   select vault.create_secret('1x0000000000000000000000000000000AA', 'turnstile_secret');
   ```
   (Leave Auth → CAPTCHA protection off in the test project.)
4. In `js/config.js`, fill in the `LOCAL_TEST` section with the test project's URL and publishable key. On `localhost` the site then uses the test project automatically; the live site keeps using `LIVE`.
5. Run:
   ```bash
   python dev/server.py --real
   ```

If `LOCAL_TEST` is empty, `--real` connects to the **live** database, and a red warning bar at the top says so.

For password-reset emails in test mode, add `http://localhost:8765/admin/` to the test project's **Authentication → URL Configuration → Redirect URLs**.

### Getting a change live

1. Edit the files and check them in demo or test mode.
2. **If you changed `supabase/schema.sql`:** run it in the test project first. When it works, run it in the **live** project right before pushing.
3. Commit and push:
   ```bash
   git add .
   git commit -m "Describe the change"
   git push
   ```
4. Cloudflare rebuilds the live site in about a minute.

Want to try something bigger without it going live? Work on a branch (`git switch -c my-idea`) and push that. Only `main` updates the live site. Merge into `main` when it's ready (`git switch main`, `git merge my-idea`, `git push`). You can check which branches Cloudflare builds under your Worker's **Settings → Build**.

## Troubleshooting

- **"This closet isn't connected to its database yet"**: `js/config.js` still has the placeholder values (step 4).
- **"That code didn't work"** every time: the phone's clock is probably off. Turn on automatic date and time on the phone. Codes are only valid for about 30 seconds.
- **Lost phone / new phone:** see [Two-step sign-in](#two-step-sign-in).
- **Everyone was asked to set up two-step sign-in after an update:** that's expected the first time after two-step sign-in was added.
- **"That account isn't set up as a coordinator"**: the user exists but isn't in the `admins` table (step 5).
- **"permission denied" / "Not authorized"** in the admin: same cause, or the schema script didn't finish. Re-run `schema.sql`.
- **Photo won't upload from an iPhone**: some browsers can't read HEIC. On the iPhone, go to Settings → Camera → Formats → *Most Compatible*, or send the photo as JPEG.
- **Site suddenly can't load anything**: the Supabase project may be paused. Restore it from the dashboard, and set up step 8.
- **"Please complete the robot check" / "The robot check didn't go through"**: the site key in `js/config.js` must belong to the same Turnstile widget as the secret in Vault and in Supabase Auth. The widget's hostname list must also include the address you're visiting (including `localhost` when testing).
- **Families suddenly can't send requests right after step 9**: the Vault secret is set but the site with the site key hasn't deployed yet. Wait for the deploy, or check Settings → Bot protection.
- **Coordinator can't sign in after turning on CAPTCHA in Supabase**: the deployed `js/config.js` doesn't have the site key yet. Add it and push, or turn CAPTCHA protection off again in Supabase.
- **Fonts or the Supabase library blocked**: if you add other third-party scripts, update the `Content-Security-Policy` line in `_headers` to allow them.

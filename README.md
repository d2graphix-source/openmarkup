# OpenMarkup

Review a real, working website (animations, menus and accordions included) and pin comments to exact spots on it.
Share a link with people who have no login, and export every comment as Markdown for an AI chat, an issue or a brief.

- **Desktop, tablet and phone** sizes, each with its own comments.
- **Browse / Comment** switch: use the site normally, then click anything to pin a comment.
- **Threads** with replies, resolve and reopen, and editing your own words (marked "edited").
- **Pictures**: a screenshot around each click is saved with the comment, and up to four images can be attached.
- **Share links** for guests: look-only or comment, switch off or replace any time. Guests give a name to comment.
- **Pages behind a login**: a second link opens the real site with a small comment panel, so reviewers log in with
  their own account and still comment.
- **Change address**: when a site moves to a new domain, every comment moves with it (the old domain is kept as an alias).
- **Claude connection (MCP)**: each member can make a private connector address on their account page. Claude can then
  list reviews, read every comment (page, element, screenshot) and reply or mark comments resolved, as that member.
- **Markdown export**: "Copy as markdown" or download a `.md` file, grouped by screen size and page, with each element's
  selector, text and picture links.

Stack: Next.js 15 (App Router) on Vercel, and Supabase (Postgres with row-level security, Auth and Storage).

## How it fits together

```
 Browser ── app (Next.js) ───────── Supabase: reviews, threads, comments, share links, pictures (RLS)
   │
   └─ iframe ── https://the-real-site   (with openmarkup.js in its <head>)
```

Each reviewed site carries one script tag, `openmarkup.js`, served by the app. It does nothing for ordinary visitors.
Inside the review frame it loads `widget.js`, which draws the pins and talks to the app by `postMessage`, checking
origins on both sides. The frame never talks to the database: the app saves everything through server actions that run
as the signed-in person, so row-level security applies. Only the app's own hostname is needed; there is no proxy.

## Setup

### 1. Supabase
1. Create a project at supabase.com.
2. SQL Editor > New query > paste all of `supabase/schema.sql` > Run. (It also creates the two private picture buckets.)
3. Authentication > Users > **Add user** > Create new user, for each person (email and password; tick "Auto confirm").
   Every login is a member and can see every review. To let people sign themselves up instead, set `ALLOW_SIGNUP=true`.
4. Make yourself an admin (admins can delete any review):
   ```sql
   update public.profiles set is_admin = true where user_id = (select id from auth.users where email = 'you@example.com');
   ```
5. Authentication > URL Configuration: set Site URL to your app address.
6. Project Settings > API: copy the URL, the `anon` key and the `service_role` key for the next step.

Upgrading a database made with an earlier version? Run `supabase/upgrade-2026-11.sql` once, then
`supabase/upgrade-2026-11-mcp.sql` (the Claude connection).

### 2. Vercel
1. Import the GitHub repo as a new project (framework: Next.js; no build settings to change).
2. Settings > Environment Variables: add everything in `.env.example` (Production and Preview).
3. Deploy, then add your domain under Settings > Domains and set `APP_ORIGIN` to it.

### 3. Each site you review
Add the script tag to the site's `<head>`. The full guide, including where it goes on WordPress and what to do if the
site blocks framing, is [docs/SCRIPT.md](docs/SCRIPT.md). A running app also serves it at `/setup.md` with its own
address filled in, and every review page shows the exact tag.

### 4. Connect Claude (optional)
Account > Connect Claude > Make a connection address. In Claude: Settings > Connectors > Add custom connector, paste the
address. Tools: `list_reviews`, `get_review`, `reply_to_comment`, `resolve_comment`. The address works like a password:
"Make a new address" replaces it, "Disconnect" removes it.

## Development
```bash
cp .env.example .env.local   # fill it in
npm install
npm run dev                  # http://localhost:3000
npm test                     # unit tests (sites, links, markdown)
npm run test:e2e             # real-Chromium end-to-end test of script + frame + host (set CHROMIUM_PATH)
npm run typecheck
```
`npm run build` builds the site scripts in `public/review-assets/` first (they are not committed). During `npm run dev`,
run `npm run build:review` once, and again after changing `src/review/frame` or `src/review/shared`.

## Layout
```
supabase/schema.sql          the whole database: tables, row-level security, triggers, storage buckets
src/middleware.ts            login gate
src/app/                     pages: / (reviews), /reviews/[id], /r/[id] (full screen), /live/[token] (guests),
                             /live/[token]/dock (panel on pages behind a login), /login, /account, /setup.md
src/app/api/reviews/[id]/markdown   .md download
src/review/actions.ts        server actions: start, comment, reply, resolve, edit, delete, share, change address, export
src/review/context.ts        who is asking (member or share link) and what they may do
src/review/markdown.ts       the Markdown export
src/review/frame/            scripts that run on the reviewed site (openmarkup.js entry, pins, anchoring, screenshots)
src/review/host/             the app-side controller for the frame
src/review/shared/           message protocol and URL helpers used by both sides
public/review-assets/        openmarkup.js, widget.js and snap.js, built by npm run build
```

## Known limits
- The site must allow being framed by the app (see docs/SCRIPT.md).
- Pins can't attach inside embedded videos, maps or canvases; they attach to the box around them.
- Other people's new comments appear within about 15 seconds.

## License
MIT. See `LICENSE`.

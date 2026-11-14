// The script setup guide, served at /setup.md with this app's real address filled in, and copied to docs/SCRIPT.md.
export function setupGuide(app: string): string {
  const tag = `<script src="${app}/review-assets/openmarkup.js" async></script>`;
  return `# Adding the OpenMarkup script to a site

OpenMarkup shows a site inside the review screen and puts comment pins on it. For that to work, the site needs one script tag in its \`<head>\`:

\`\`\`html
${tag}
\`\`\`

The script does nothing for normal visitors. It only wakes up when:

- the page is shown inside the OpenMarkup review screen, or
- someone opens a "for pages behind a login" link (it ends in \`?openmarkup=...\`). Then a small comment panel appears on the real page, so reviewers can log in with their own account and still comment.

Add it to every site you want to review, staging and live alike.

## WordPress

Pick one of these. All of them put the tag in the \`<head>\` of every page.

1. **A code snippets plugin (easiest).** In WPCode or Code Snippets, add a new snippet of type HTML (WPCode: "Header & Footer" > Header), paste the tag above, set it to run on the site front end, and activate it.
2. **Elementor Pro.** Elementor > Custom Code > Add New. Paste the tag, set Location to \`<head>\`, publish, and set the condition to the entire site.
3. **A child theme.** Add this to the child theme's \`functions.php\` (not the parent theme, or an update will wipe it):

\`\`\`php
add_action( 'wp_head', function () {
    echo '${tag}' . "\\n";
} );
\`\`\`

After adding it, clear every cache (the caching plugin, and the host's cache, for example WP Engine > Caching > Clear all caches). Then open a review of the site and check the pins appear.

## Other sites

Paste the tag into the shared layout's \`<head>\` (for example \`app/layout.tsx\` in Next.js, \`index.html\` in a Vite app, or the site builder's "custom code in head" setting).

## If the review screen stays blank or says the page is silent

The site has to allow being shown inside OpenMarkup:

- **X-Frame-Options.** Remove \`X-Frame-Options: DENY\` or \`SAMEORIGIN\` from the site's response headers (security plugins and some hosts add it).
- **Content-Security-Policy.** If the site sends one, allow the app:
  - \`frame-ancestors 'self' ${app}\`
  - \`script-src ... ${app}\`
  - \`frame-src ... ${app}\` (for the comment panel on pages behind a login)
  - \`img-src ... data: blob:\` and \`connect-src ... ${app}\` if those are restricted.
- **Cache.** The page may still be served from a cache made before the script was added. Clear it.

To check, open the site, view the page source and search for \`openmarkup.js\`.
`;
}

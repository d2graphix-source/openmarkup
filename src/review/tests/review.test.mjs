import test from "node:test";
import assert from "node:assert/strict";
import { reviewToMarkdown } from "../markdown.ts";
import { parseSite, pageBelongsToSite, cleanName, toDbViewport, fromDbViewport, onsiteLink, onCurrentSite } from "../lib.ts";

test("parseSite: adds https, keeps the first page, and refuses private addresses", () => {
  assert.deepEqual(parseSite("example.com"), { ok: true, origin: "https://example.com", startPath: "/" });
  assert.deepEqual(parseSite(" https://www.example.com/about?x=1 "), { ok: true, origin: "https://www.example.com", startPath: "/about?x=1" });
  for (const bad of ["", "ftp://example.com", "http://127.0.0.1/", "http://localhost:3000", "https://intranet/", "https://10.0.0.5", "https://user:pw@example.com", "not a url"]) {
    assert.equal(parseSite(bad).ok, false, bad);
  }
});

test("pageBelongsToSite: same site or an alias, nothing else", () => {
  assert.equal(pageBelongsToSite("https://example.com/a", "https://example.com"), true);
  assert.equal(pageBelongsToSite("https://www.example.com/a", "https://example.com"), true);
  assert.equal(pageBelongsToSite("https://shop.example.com/a", "https://example.com", ["shop.example.com"]), true);
  assert.equal(pageBelongsToSite("https://example.com.evil.io/a", "https://example.com"), false);
  assert.equal(pageBelongsToSite("javascript:alert(1)", "https://example.com"), false);
  assert.equal(pageBelongsToSite("nonsense", "https://example.com"), false);
});

test("names and viewports", () => {
  assert.equal(cleanName("  Dana   Lee \n"), "Dana Lee");
  assert.equal(cleanName("x".repeat(200)).length, 80);
  assert.equal(toDbViewport("Phone"), "phone");
  assert.equal(toDbViewport("Desktop"), "desktop");
  assert.equal(fromDbViewport("phone"), "Phone");
  assert.equal(toDbViewport("Tablet"), "tablet");
  assert.equal(fromDbViewport("tablet"), "Tablet");
});

test("onsiteLink adds the token to the start page", () => {
  assert.equal(onsiteLink("https://a.com", "/", "tok123"), "https://a.com/?openmarkup=tok123");
  assert.equal(onsiteLink("https://a.com", "/p?x=1", "tok123"), "https://a.com/p?x=1&openmarkup=tok123");
});

test("reviewToMarkdown: one entry per comment with page, element, text, size and replies", () => {
  const anchor = { selector: "main > h1", path: "body > h1", tag: "h1", text: "Welcome  to\nthe site", fx: 0.5, fy: 0.5, page: { x: 0, y: 0, docW: 1, docH: 1 }, viewport: { w: 1440, h: 900 } };
  const t = (id, extra) => ({ id, pageUrl: "https://example.com/about", pageKey: "/about", viewport: "Desktop", anchor, resolved: false, isPrivate: false, createdAt: "2026-10-12T00:00:00Z",
    comments: [{ id: id + "c", authorId: "u", authorName: "Dana", body: "Make it bigger\nand bolder", createdAt: "x" }], ...extra });
  const md = reviewToMarkdown({ title: "Home  page", site_origin: "https://example.com" }, [
    t("a"), t("b", { resolved: true, viewport: "Phone", comments: [{ id: "x", authorId: "u", authorName: "Dana", body: "Fix", createdAt: "x" }, { id: "y", authorId: "v", authorName: "Sam", body: "Done", createdAt: "x" }] }),
  ]);
  assert.match(md, /^# Home page\n/);
  assert.match(md, /Comments: 1 open, 1 resolved/);
  assert.match(md, /### Change 1\nPage: https:\/\/example.com\/about\nElement: `main > h1`\nElement text: "Welcome to the site"\nViewport: Desktop \(1440×900\)/);
  assert.match(md, /> Make it bigger\n> and bolder/);
  assert.match(md, /## Phone\n\n### Change 2 \(resolved\)/);
  assert.match(md, /Sam replied:\n> Done/);
  assert.match(reviewToMarkdown({ title: "x", site_origin: "https://e.com" }, []), /No comments yet\./);
});

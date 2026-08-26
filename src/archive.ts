/** What the menus need to know about an archive, which is less than it sounds.
 *
 * Only zip. A `.tar.gz` reads on a Mac and is a mystery on a phone, and `.7z`
 * and `.rar` are neither — so rather than offer Extract on everything that
 * looks compressed and refuse most of it afterwards, the question here is the
 * narrow one the backend can actually answer. See `src-tauri/src/archive.rs`.
 *
 * The other formats deliberately stay archives as far as the *icon* is
 * concerned: `glyph-category.ts` gives a `.7z` the same silhouette it always
 * had. Being able to see what something is and being able to open it are
 * different questions, and only the second one is asked here.
 */

/** Something Fiddler can unpack. Case-insensitive, because a zip that came off
 * a Windows machine is as often `.ZIP` as not. */
export function isZip(name: string): boolean {
  return /\.zip$/i.test(name);
}

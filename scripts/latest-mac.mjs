// latest-mac.yml after the dmg was stapled. Stapling changes the dmg's bytes, so its entry (and its blockmap) no longer
// match, and the Mac updater installs from the zip alone: the file is rewritten to list the zip only, and what it says of
// the zip is checked against the zip itself. Pure: it is given the file's text and what was measured of the zip.
import yaml from "js-yaml";

/**
 * @param {string} text        the latest-mac.yml electron-builder wrote
 * @param {string} zipName     the zip's file name, as the yml names it
 * @param {{ sha512: string, size: number }} zip   measured from the zip on disk (sha512 base64)
 * @returns {string} the new text
 */
export function zipOnly(text, zipName, zip) {
  const doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("latest-mac.yml is not a mapping");
  if (!Array.isArray(doc.files)) throw new Error("latest-mac.yml has no files list");
  if (doc.path !== zipName) throw new Error(`the top-level path is ${String(doc.path)}, not the zip ${zipName}`);
  if (doc.sha512 !== zip.sha512) throw new Error("the top-level sha512 is not the zip's");
  if (doc.size !== undefined && doc.size !== zip.size) throw new Error("the top-level size is not the zip's");
  const entry = doc.files.find((f) => f && typeof f === "object" && f.url === zipName);
  if (!entry) throw new Error(`the files list does not name the zip ${zipName}`);
  if (entry.sha512 !== zip.sha512) throw new Error("the zip's sha512 in the files list is not the zip's");
  if (entry.size !== zip.size) throw new Error("the zip's size in the files list is not the zip's");
  return yaml.dump({ ...doc, files: [entry] }, { lineWidth: -1, noRefs: true });
}

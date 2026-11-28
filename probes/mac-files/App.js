// Can a workspace's code, run in Expo Go in the iOS Simulator, read the Mac's own files? (SECURITY.md: "unsettled".)
// It tries a harmless system file and a file made for the test, three ways each, and whether it can list the home and the
// per-user temporary folders' parent, and says what came back. It never shows what it read but the test file's own words:
// for the rest, a length or a count. Nothing is sent anywhere; each line is also logged to Metro's output, as [mac-files].
// Not part of the app: README.md beside it says how to run it, and what to do with what it says.
import { useEffect, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text } from "react-native";
import * as FS from "expo-file-system";

const short = (s) => String(s).replace(/\s+/g, " ").slice(0, 160);

// expo-file-system has had two shapes: File and Directory (SDK 54 on), and functions before it. Either is used.
const appFolder = () => (FS.Paths && FS.Paths.document && FS.Paths.document.uri) || FS.documentDirectory || "";
async function readText(uri) {
  if (FS.File) { const f = new FS.File(uri); return typeof f.text === "function" ? await f.text() : f.textSync(); }
  if (FS.readAsStringAsync) return FS.readAsStringAsync(uri);
  throw new Error("this SDK's expo-file-system has neither shape");
}
async function list(uri) {
  if (FS.Directory) return new FS.Directory(uri).list();
  if (FS.readDirectoryAsync) return FS.readDirectoryAsync(uri);
  throw new Error("this SDK's expo-file-system has neither shape");
}
function xhr(uri) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.onload = () => ok(x.responseText);
    x.onerror = () => no(new Error("XMLHttpRequest error"));
    x.open("GET", uri);
    x.send();
  });
}

async function attempt(what, f, show) {
  try { return `${what}: READ, ${show(await f())}`; }
  catch (e) { return `${what}: refused, ${short((e && e.message) || e)}`; }
}

async function probe() {
  const out = [];
  const folder = appFolder();
  // The app's own folder is under the Mac's home (…/Library/Developer/CoreSimulator/…): the home is found from it, not named.
  const m = /^file:\/\/(\/Users\/[^/]+)\//.exec(folder);
  const home = m ? m[1] : null;
  out.push(`the app's own folder is under the Mac's home: ${home ? "yes" : `no (${short(folder)})`}`);
  const size = (t) => `${String(t).length} characters`;
  const words = (t) => `"${short(t).trim()}"`;
  const files = [["/etc/hosts", "file:///etc/hosts", size]];
  if (home) files.push(["~/oerba-probe.txt", `file://${home}/oerba-probe.txt`, words]);
  for (const [name, uri, show] of files) {
    out.push(await attempt(`fetch ${name}`, async () => (await fetch(uri)).text(), show));
    out.push(await attempt(`XMLHttpRequest ${name}`, () => xhr(uri), show));
    out.push(await attempt(`expo-file-system ${name}`, () => readText(uri), show));
  }
  const count = (a) => `${a.length} entries`;
  if (home) out.push(await attempt("list the home", () => list(`file://${home}/`), count));
  out.push(await attempt("list /var/folders", () => list("file:///var/folders/"), count));
  return out;
}

export default function App() {
  const [lines, setLines] = useState(["Trying…"]);
  useEffect(() => {
    probe().then((out) => {
      for (const l of out) console.log("[mac-files] " + l);
      setLines(out);
    }, (e) => setLines([`the probe itself failed: ${short((e && e.message) || e)}`]));
  }, []);
  return (
    <SafeAreaView style={s.page}>
      <ScrollView contentContainerStyle={s.list}>
        <Text style={s.head}>Can this app read the Mac's files?</Text>
        {lines.map((l, i) => <Text key={i} style={/READ/.test(l) ? s.read : s.line}>{l}</Text>)}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  list: { padding: 16, gap: 10 },
  head: { fontSize: 18, fontWeight: "600", marginBottom: 6 },
  line: { fontSize: 13, color: "#333" },
  read: { fontSize: 13, color: "#b00020", fontWeight: "600" },
});

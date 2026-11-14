/* How the global shortcut opens Oerba's own palette. Oerba's page listens for ⌘K on its own document. The key is delivered
   to Oerba's TOP frame only, by running this fixed string there, and never by sendInputEvent, which goes to whichever frame
   has the focus (a workspace door is a frame running somebody else's code). It is not a press the window received, so it is
   not a gesture for the link-out gate either. The string holds nothing from anywhere. */
export const OPEN_PALETTE_JS = 'document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))';
